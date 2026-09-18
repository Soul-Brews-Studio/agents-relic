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
        _ => {
            eprintln!("relic-native — read paths only. Implemented: now");
            eprintln!("Everything else lives in the TypeScript CLI: relic <cmd>");
            std::process::exit(2);
        }
    }
}
