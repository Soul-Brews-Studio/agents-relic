//! Native binary for agents-relic's hot read paths.
//!
//! This is NOT a port of the TypeScript CLI. `src/cli.ts` remains the reference
//! implementation and owns every write path (index, import, cache). This binary
//! implements only read commands, and only where a native build actually wins.
//!
//! The split is principled, not arbitrary — it follows whether a command needs
//! LanceDB at all:
//!
//!   index-free (`now`)   pure readdir + mtime. A native build pays NO engine
//!                        init, so it is bounded by syscalls. This is where the
//!                        large win is.
//!
//!   index-backed (`session`, `search`)  all three bindings (TS, Python, Rust)
//!                        wrap the SAME Rust `lance` core, so the query costs
//!                        the same in every one of them. Native saves only the
//!                        host-language startup slice. Included for parity, not
//!                        because it is dramatically faster.
//!
//! Anything not implemented here MUST fall through to the TypeScript CLI rather
//! than being reimplemented — two implementations of the parser or the schema is
//! exactly the maintenance trap this split exists to avoid.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// cwd -> Claude Code's project-directory name. BOTH `/` and `.` become `-`.
/// Decoding is lossy and is never attempted; only this forward direction is used.
fn encode_claude_dir(cwd: &str) -> String {
    cwd.chars()
        .map(|c| if c == '/' || c == '.' { '-' } else { c })
        .collect()
}

/// cwd -> omp's session-directory name. Only `/` becomes `-`; dots survive, and
/// the whole thing is wrapped in `--`. Verified against a real directory, not
/// inferred from Claude's encoder — using the wrong one silently matches nothing.
fn encode_omp_dir(cwd: &str) -> String {
    let joined: Vec<&str> = cwd.split('/').filter(|s| !s.is_empty()).collect();
    format!("--{}--", joined.join("-"))
}

fn secs_since(t: SystemTime) -> u64 {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();
    let then = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(now);
    now.saturating_sub(then)
}

struct Found {
    path: PathBuf,
    age: u64,
}

/// Newest `.jsonl` directly inside `dir`.
fn newest_jsonl(dir: &Path) -> Option<Found> {
    let mut best: Option<(PathBuf, SystemTime)> = None;
    for entry in fs::read_dir(dir).ok()?.flatten() {
        let p = entry.path();
        if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let m = entry.metadata().ok()?.modified().ok()?;
        if best.as_ref().map_or(true, |(_, bt)| m > *bt) {
            best = Some((p, m));
        }
    }
    best.map(|(path, t)| Found { age: secs_since(t), path })
}

/// Which session is running in `cwd`, across every source, newest wins.
///
/// Compares mtime across ALL sources rather than returning the first source
/// that has a matching directory — returning first-match made an omp agent
/// always resolve to the newest CLAUDE session instead of its own, silently.
fn current_session(cwd: &str) -> Option<(String, PathBuf, u64)> {
    let home = std::env::var("HOME").ok()?;
    let mut candidates: Vec<PathBuf> = Vec::new();

    // Walk up: a session's dir is keyed on where the agent STARTED, usually a
    // repo root, so running from a subdirectory must still resolve.
    let mut cur = Some(Path::new(cwd));
    while let Some(d) = cur {
        let s = d.to_string_lossy().to_string();
        candidates.push(PathBuf::from(format!("{home}/.claude/projects/{}", encode_claude_dir(&s))));
        candidates.push(PathBuf::from(format!("{home}/.claude/projects-archive/{}", encode_claude_dir(&s))));
        candidates.push(PathBuf::from(format!("{home}/.omp/agent/sessions/{}", encode_omp_dir(&s))));
        cur = d.parent();
    }

    let mut best: Option<(String, PathBuf, u64)> = None;
    for dir in candidates {
        if !dir.is_dir() {
            continue;
        }
        if let Some(f) = newest_jsonl(&dir) {
            let stem = f.path.file_stem()?.to_string_lossy().to_string();
            // omp filenames are <timestamp>_<uuid>; Claude's stem IS the uuid.
            let id = stem.rsplit('_').next().unwrap_or(&stem).to_string();
            if best.as_ref().map_or(true, |(_, _, ba)| f.age < *ba) {
                best = Some((id, f.path.clone(), f.age));
            }
        }
    }
    best
}

fn human_age(s: u64) -> String {
    if s < 60 { format!("{s}s") }
    else if s < 5400 { format!("{}m", (s as f64 / 60.0).round()) }
    else { format!("{:.1}h", s as f64 / 3600.0) }
}

// ---------------------------------------------------------------- banks & shards
//
// A BANK is one whole source root — a Claude projects dir, codex, omp, memory —
// and it is the top level of the shard path:
//
//     ~/.relic/banks/<bank>/github.com/<org>/<repo>/
//
// Enumerating that is pure readdir, so it stays in the DEFAULT zero-dependency
// build alongside `now`. Counting rows inside a shard needs the lance engine and
// therefore the `index` feature; listing which shards exist does not, and the
// listing is most of what a caller wants before it asks anything expensive.

struct Shard {
    key: String,  // "<bank>/github.com/<org>/<repo>" — display only, no filter takes it
    dir: PathBuf,
    bank: String,
    repo: String, // "github.com/<org>/<repo>", or "_unresolved"
}

fn relic_root() -> PathBuf {
    if let Ok(r) = std::env::var("RELIC_DATA_ROOT") {
        if !r.is_empty() {
            return PathBuf::from(r);
        }
    }
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join(".relic")
}

/// Directory names one level under `p`, sorted, skipping dot-dirs AND `*.lance`.
///
/// The `.lance` skip is not cosmetic: LanceDB's own table directories live INSIDE
/// a shard, and a walker that does not skip them enumerates `events.lance` as if
/// it were an org or a repo.
fn subdirs(p: &Path) -> Vec<String> {
    let mut out: Vec<String> = match std::fs::read_dir(p) {
        Ok(rd) => rd
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| !n.starts_with('.') && !n.ends_with(".lance"))
            .collect(),
        Err(_) => Vec::new(),
    };
    out.sort();
    out
}

/// Every shard under the index root. Three levels below `banks/`, plus the
/// `_unresolved` bucket which sits directly under a bank with no host/org/repo.
fn list_shards(root: &Path) -> Vec<Shard> {
    let mut out = Vec::new();
    let banks_root = root.join("banks");
    for bank in subdirs(&banks_root) {
        let bank_dir = banks_root.join(&bank);

        let unresolved = bank_dir.join("_unresolved");
        if unresolved.is_dir() {
            out.push(Shard {
                key: format!("{bank}/_unresolved"),
                dir: unresolved,
                bank: bank.clone(),
                repo: "_unresolved".to_string(),
            });
        }

        for host in subdirs(&bank_dir) {
            if host == "_unresolved" {
                continue;
            }
            let host_dir = bank_dir.join(&host);
            for org in subdirs(&host_dir) {
                let org_dir = host_dir.join(&org);
                for repo in subdirs(&org_dir) {
                    let repo_path = format!("{host}/{org}/{repo}");
                    out.push(Shard {
                        key: format!("{bank}/{repo_path}"),
                        dir: org_dir.join(&repo),
                        bank: bank.clone(),
                        repo: repo_path,
                    });
                }
            }
        }
    }
    out
}

/// `--bank` is EXACT; `--repo` is a substring of the REPO PORTION only.
///
/// Matching `--repo` against `key` would make `--repo projects` quietly select a
/// whole bank, because the key begins with the bank name.
fn filter_shards(shards: Vec<Shard>, bank: Option<&str>, repo: Option<&str>) -> Vec<Shard> {
    shards
        .into_iter()
        .filter(|s| bank.map(|b| s.bank == b).unwrap_or(true))
        .filter(|s| repo.map(|r| s.repo.contains(r)).unwrap_or(true))
        .collect()
}

fn flag<'a>(args: &'a [String], name: &str) -> Option<&'a str> {
    let mut it = args.iter();
    while let Some(a) = it.next() {
        if a == name {
            return it.next().map(|s| s.as_str());
        }
        if let Some(v) = a.strip_prefix(&format!("{name}=")) {
            return Some(v);
        }
    }
    None
}

// ------------------------------------------------------------------- live scan
//
// The expensive half of "what is running right now" is not resolving one session —
// that is 1 ms — it is the sweep that asks EVERY project directory under EVERY
// source root whether anything in it was written recently. Measured in the
// TypeScript implementation: currentSession() 1 ms, liveSessions() 207 ms, over
// roughly 1,500 project directories and several thousand stat() calls.
//
// So this implements exactly that sweep and nothing else. It returns the FRESH
// CANDIDATES — project directory plus the session uuids in it that look active —
// and the caller still does the rest (reading each transcript's head for cwd and
// title, building the tree). That split is deliberate: the sweep is pure syscalls
// and parallelises, while the part that parses transcripts is where the output
// format lives, and a second implementation of a format is a second thing to
// drift.
//
// ROOTS COME FROM THE CALLER, after `--`. This binary deliberately knows nothing
// about ~/.relic/sources.json — config stays in one place, and a native binary
// that silently disagreed with the TypeScript source registry about which roots
// exist would be very hard to notice.

fn json_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            '\n' => o.push_str("\\n"),
            '\r' => o.push_str("\\r"),
            '\t' => o.push_str("\\t"),
            c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
            c => o.push(c),
        }
    }
    o
}

/// Fresh session uuids inside ONE project directory.
///
/// Two gates, matching the reference implementation exactly:
///   1. a top-level `<uuid>.jsonl` whose own mtime is inside the window
///   2. a `<uuid>/subagents/` directory whose mtime is inside the window —
///      because a child write does not always bump the parent transcript
fn fresh_in_project(pdir: &Path, window: u64) -> Vec<String> {
    let mut fresh: Vec<String> = Vec::new();

    if let Ok(rd) = std::fs::read_dir(pdir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !name.ends_with(".jsonl") {
                continue;
            }
            if e.metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(|t| secs_since(t) <= window)
                .unwrap_or(false)
            {
                fresh.push(name.trim_end_matches(".jsonl").to_string());
            }
        }
    }

    for d in subdirs(pdir) {
        if fresh.iter().any(|f| f == &d) {
            continue;
        }
        let sub = pdir.join(&d).join("subagents");
        if std::fs::metadata(&sub)
            .ok()
            .and_then(|m| m.modified().ok())
            .map(|t| secs_since(t) <= window)
            .unwrap_or(false)
        {
            fresh.push(d);
        }
    }
    fresh
}

/// Sweep every project directory under every given root, in parallel.
///
/// std::thread::scope, not a runtime — this is blocking syscalls fanned over a
/// fixed set of threads, which needs no async and no dependency.
fn live_scan(roots: &[String], window: u64) -> Vec<(PathBuf, Vec<String>)> {
    let mut projects: Vec<PathBuf> = Vec::new();
    for r in roots {
        let root = PathBuf::from(r);
        for p in subdirs(&root) {
            projects.push(root.join(p));
        }
    }

    let nthreads = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4)
        .min(16)
        .max(1);
    let chunk = projects.len().div_ceil(nthreads).max(1);

    let mut out: Vec<(PathBuf, Vec<String>)> = Vec::new();
    std::thread::scope(|sc| {
        let mut handles = Vec::new();
        for part in projects.chunks(chunk) {
            handles.push(sc.spawn(move || {
                let mut got = Vec::new();
                for pdir in part {
                    let fresh = fresh_in_project(pdir, window);
                    if !fresh.is_empty() {
                        got.push((pdir.clone(), fresh));
                    }
                }
                got
            }));
        }
        for h in handles {
            if let Ok(mut got) = h.join() {
                out.append(&mut got);
            }
        }
    });
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("help");

    match cmd {
        "now" => {
            let cwd = std::env::current_dir()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default();
            match current_session(&cwd) {
                Some((id, path, age)) => {
                    println!("{id}");
                    println!("last write {} ago", human_age(age));
                    println!("{}", path.display());
                }
                None => {
                    eprintln!("no session transcript for {cwd}");
                    std::process::exit(1);
                }
            }
        }
        "live" => {
            let window: u64 = flag(&args, "--window")
                .and_then(|v| v.parse().ok())
                .unwrap_or(300);
            // Roots come after `--`, so a root that begins with a dash, or one
            // that happens to equal a flag name, cannot be mistaken for a flag.
            let roots: Vec<String> = match args.iter().position(|a| a == "--") {
                Some(i) => args[i + 1..].to_vec(),
                None => {
                    eprintln!("usage: relic-native live [--window 300] -- <root>...");
                    std::process::exit(2);
                }
            };
            let found = live_scan(&roots, window);
            let mut first = true;
            print!("[");
            for (pdir, uuids) in &found {
                if !first {
                    print!(",");
                }
                first = false;
                print!(
                    "{{\"project\":\"{}\",\"uuids\":[",
                    json_escape(&pdir.to_string_lossy())
                );
                for (i, u) in uuids.iter().enumerate() {
                    if i > 0 {
                        print!(",");
                    }
                    print!("\"{}\"", json_escape(u));
                }
                print!("]}}");
            }
            println!("]");
        }
        "banks" => {
            let root = relic_root();
            let shards = list_shards(&root);
            if shards.is_empty() {
                eprintln!("no shards under {}", root.join("banks").display());
                std::process::exit(1);
            }
            let mut names: Vec<&str> = shards.iter().map(|s| s.bank.as_str()).collect();
            names.sort();
            names.dedup();
            for n in names {
                println!("{n}");
            }
        }
        "shards" => {
            let root = relic_root();
            let shards = filter_shards(
                list_shards(&root),
                flag(&args, "--bank"),
                flag(&args, "--repo"),
            );
            if args.iter().any(|a| a == "--count") {
                println!("{}", shards.len());
            } else {
                for s in &shards {
                    println!("{}\t{}", s.key, s.dir.display());
                }
            }
        }
        _ => {
            eprintln!("relic-native — read paths only. Implemented: now, live, banks, shards");
            eprintln!("  banks                          bank names on this machine");
            eprintln!("  shards [--bank B] [--repo S] [--count]");
            eprintln!("  live [--window 300] -- <root>...   fresh sessions as JSON");
            eprintln!("Everything else lives in the TypeScript CLI: relic <cmd>");
            std::process::exit(2);
        }
    }
}
