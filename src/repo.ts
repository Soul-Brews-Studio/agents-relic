import { execSync } from "node:child_process";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirUnreadable } from "./unreadable.js";

/**
 * Map a session's cwd to the repo that owns it — "github.com/<org>/<repo>".
 *
 * Host-independent BY DESIGN, the same principle as the path-independent event uid.
 * The same repo sits at a different absolute path on every machine in this fleet, and
 * sessions carry whichever one they ran under:
 *
 *   /opt/Code/github.com/acme/my-repo            machine A
 *   /home/dev/Code/github.com/acme/my-repo       machine B
 *   /home/ci/ghq/github.com/acme/my-repo         another account
 *
 * Keying on a fixed prefix would shard one repo into four. So: find the
 * `github.com/<org>/<repo>` triple ANYWHERE in the path and stop there. Everything
 * deeper — worktrees under wt/, agents/, psi/lab/... — belongs to the owning repo.
 */
/** Forge hosts whose path segment starts a `<host>/<org>/<repo>` triple, as ghq lays them out. */
export const REPO_HOSTS = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"];

/** Index of the first forge-host segment in a split path, or -1. */
function hostIndex(parts: string[]): number {
  return parts.findIndex(p => REPO_HOSTS.includes(p));
}

export function repoKeyOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);

  const gh = hostIndex(parts);
  if (gh >= 0 && parts.length >= gh + 3) return `${parts[gh]}/${parts[gh + 1]}/${normalizeRepo(parts[gh + 2])}`;

  // incubate worktrees drop the host segment: .../incubate/worktrees/<org>/<repo>/...
  const wt = parts.indexOf("worktrees");
  if (wt > 0 && parts.length >= wt + 3 && parts[wt - 1] === "incubate")
    return `github.com/${parts[wt + 1]}/${normalizeRepo(parts[wt + 2])}`;

  return null;
}

/**
 * Every `github.com/<org>/<repo>` under the ghq root, built once.
 *
 * The lookup the two fallbacks below need, and the reason they cannot live inside
 * repoKeyOf(): that function is PURE — a path in, a key out, no filesystem — which is
 * what makes it host-independent and trivially testable. Resolving a bare repo NAME to
 * its org requires knowing what exists on this machine, so it belongs out here, called
 * only from the import path where the filesystem is already in play.
 */
let repoIndexCache: Map<string, string[]> | null = null;
/** Both caches are one fact about this machine — reset them together or they drift. */
export function resetRepoIndex(): void {
  repoIndexCache = null; canonCache = null; mappingsCache = null; remoteCache.clear();
}
export function repoIndex(): Map<string, string[]> {
  if (repoIndexCache) return repoIndexCache;
  const out = new Map<string, string[]>();
  const host = join(ghqRoot(), "github.com");
  /*
   * One listing per directory, not one try around the whole walk. The single try read
   * "no ghq root here" correctly, and still does — ENOENT is quiet — but it also turned
   * ONE unreadable org into the end of the walk: every org listed after it vanished
   * from the index, and their repos fell back to `_unresolved` in silence (#99).
   */
  for (const org of listing(host)) {
    if (!org.isDirectory()) continue;
    for (const repo of listing(join(host, org.name))) {
      if (!repo.isDirectory()) continue;
      const name = normalizeRepo(repo.name);
      const key = `github.com/${org.name}/${name}`;
      const prior = out.get(name) ?? [];
      if (!prior.includes(key)) prior.push(key);
      out.set(name, prior);
    }
  }
  repoIndexCache = out;
  return out;
}

/**
 * A directory's entries, or none — and a line on stderr when "none" is not "missing"
 * (#99). listShards walks the index with it too: an unreadable bank or org used to make
 * its shards vanish from every search and status without a word.
 */
function listing(p: string) {
  try { return readdirSync(p, { withFileTypes: true }); }
  catch (e) { dirUnreadable(p, e); return []; }
}

/** Exactly one repo of this name, or null. AMBIGUITY IS NOT RESOLVED BY GUESSING. */
function uniqueRepo(name: string): string | null {
  const hits = repoIndex().get(normalizeRepo(name));
  // Two orgs owning a repo of the same name is real (forks, `-oracle` suffixes), and
  // picking one would silently file a session under the wrong org. `_unresolved` is
  // the honest answer and `cwd` is still searchable.
  return hits && hits.length === 1 ? hits[0] : null;
}

/**
 * repoKeyOf, plus the shapes that need to know what exists on this machine.
 *
 * Measured over 1,905 codex sessions on two machines, 189 resolved to `_unresolved`:
 *
 *   149  /Users/beta/psi-memory, sandboxes, /tmp        genuinely not a repo — CORRECT
 *    20  ~/.herdr/worktrees/<repo>/<space>/...          recoverable
 *    16  /private/tmp/claude-<uid>/-<encoded-path>/...  recoverable
 *
 * So most of `_unresolved` is right and stays. These two are checkouts OF a repo whose
 * identity is in the path, just not as a `github.com/<org>/<repo>` triple.
 */
/**
 * The ghq tree's OWN spelling of a repo key, case-corrected.
 *
 * `repoKeyOf` echoes whatever casing the session's cwd used, so one repo acquires
 * several keys and `--repo` — which filters the column exactly — reaches a fraction of
 * its own history. Measured on the live index before this:
 *
 *     2,849 events in one shard, 3 distinct repo_key
 *       2,720  github.com/laris-co/DustBoy-Oracle
 *         119  github.com/laris-co/Dustboy-Oracle
 *          10  github.com/laris-co/dustboy-oracle
 *
 * `relic search --repo Dustboy-Oracle` reached 119 of 2,849 and reported success.
 *
 * ON macOS THE DIRECTORY HID IT. All three spellings resolved to inode 520201074 —
 * one directory, three keys inside. A case-sensitive filesystem splits it for real:
 * three shard directories, a third of the history in each. white.local is Ubuntu.
 *
 * NOT in repoKeyOf(), which is pure by design — a path in, a key out, no filesystem.
 * Canonicalising needs to know what exists on this machine, so it lives here with the
 * other index-backed fallbacks.
 */
let canonCache: Map<string, string> | null = null;
export function canonicalRepoKey(key: string): string {
  if (!canonCache) {
    canonCache = new Map();
    for (const keys of repoIndex().values())
      for (const k of keys) {
        // Exact wins over case-folded: on a case-sensitive filesystem two repos CAN
        // differ only by case, and silently folding them together would be a worse
        // bug than the one this fixes.
        canonCache.set(k, k);
        const lc = k.toLowerCase();
        if (!canonCache.has(lc)) canonCache.set(lc, k);
      }
  }
  return canonCache.get(key) ?? canonCache.get(key.toLowerCase()) ?? key;
}

export function resolveRepoKey(cwd: string | null): string | null {
  const mapped = mappedRepoKey(cwd);
  if (mapped) return mapped;
  const direct = repoKeyOf(cwd);
  // A repo this machine does not have falls through unchanged — peer roots carry paths
  // from another host, and inventing a spelling for them would be worse than echoing.
  if (direct) return canonicalRepoKey(direct);
  if (!cwd) return direct;
  const parts = cwd.split("/").filter(Boolean);

  // herdr's GLOBAL worktree root: ~/.herdr/worktrees/<repo>/<space>/...
  // Unlike `<repo>/wt/<slug>`, this carries no org — herdr keys its worktrees by repo
  // name alone — so the org has to come from the ghq index.
  const hw = parts.indexOf("worktrees");
  if (hw > 0 && parts[hw - 1] === ".herdr" && parts.length >= hw + 2) {
    const hit = uniqueRepo(parts[hw + 1]);
    if (hit) return hit;
  }

  // A Claude scratchpad: /tmp/claude-<uid>/<encoded-project-dir>/<session>/scratchpad/...
  // The encoding maps BOTH "/" and "." to "-", so the segment cannot be split back into
  // org and repo — `github-com-laris-co-haos-oracle` is equally `laris`/`co-haos-oracle`.
  // Encoding each known repo the same way and comparing is exact where decoding is not.
  const enc = parts.find(x => x.startsWith("-") && x.includes("github-com-"));
  if (enc) {
    for (const keys of repoIndex().values())
      for (const key of keys) {
        const asDir = "-" + join(ghqRoot(), key).slice(1).replace(/[/.]/g, "-");
        if (enc === asDir || enc.startsWith(asDir + "-")) return key;
      }
  }
  return remoteRepoKey(cwd);
}

/** A key relic can shard and list: `<host>/<org>/<repo>`, host a domain. */
const VALID_KEY = /^[^/\s]+\.[^/\s]+\/[^/\s]+\/[^/\s]+$/;

// `repo_mappings` in ~/.relic/sources.json: path prefix -> key, checked first, so it also covers paths gone from this machine.
let mappingsCache: [string, string][] | null = null;

/** Pure: the `repo_mappings` object of a parsed sources.json, validated, longest prefix first. */
export function parseRepoMappings(cfg: unknown, home: string, warn: (m: string) => void = () => {}): [string, string][] {
  const out: [string, string][] = [];
  const raw = (cfg as { repo_mappings?: Record<string, unknown> } | null)?.repo_mappings ?? {};
  for (const [prefix, key] of Object.entries(raw)) {
    const p = prefix.startsWith("~/") ? join(home, prefix.slice(2)) : prefix;
    if (typeof key === "string" && VALID_KEY.test(key) && isAbsolute(p)) out.push([p.replace(/\/+$/, ""), key]);
    else warn(`relic: ignoring repo_mappings entry ${JSON.stringify(prefix)} -> ${JSON.stringify(key)}` +
              ` (needs an absolute path and a <host>/<org>/<repo> key)`);
  }
  return out.sort((a, b) => b[0].length - a[0].length);
}

function repoMappings(): [string, string][] {
  if (mappingsCache) return mappingsCache;
  let cfg: unknown = null;
  try { cfg = JSON.parse(readFileSync(join(homedir(), ".relic", "sources.json"), "utf8")); }
  catch { /* no config — nothing to override */ }
  mappingsCache = parseRepoMappings(cfg, homedir(), m => process.stderr.write(m + "\n"));
  return mappingsCache;
}

export function mappedRepoKey(cwd: string | null, mappings: [string, string][] = repoMappings()): string | null {
  if (!cwd) return null;
  for (const [prefix, key] of mappings)
    if (cwd === prefix || cwd.startsWith(prefix + "/")) return key;
  return null;
}

/** An origin URL to `<host>/<org>/<repo>`: scp-style ssh, ssh://, https — credentials, port and .git dropped. */
export function remoteToKey(url: string): string | null {
  const u = url.trim();
  let host = "", path = "";
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(u);
  if (/^[a-z+]+:\/\//i.test(u)) {
    try { const x = new URL(u); host = x.hostname; path = x.pathname; } catch { return null; }
  } else if (scp) { host = scp[1]; path = scp[2]; }
  else return null;
  const segs = path.replace(/\.git\/?$/, "").split("/").filter(Boolean);
  // Nested groups (gitlab.com/group/sub/repo) have no <org>/<repo> shard to land in.
  if (!host.includes(".") || segs.length !== 2) return null;
  return `${host.toLowerCase()}/${segs[0]}/${normalizeRepo(segs[1])}`;
}

/** The config file of the repo that owns `dir` — a `.git` dir, or a worktree/submodule `.git` file. */
function gitConfigFor(dir: string): string | null {
  const dotgit = join(dir, ".git");
  let st;
  try { st = statSync(dotgit); } catch { return null; }
  if (st.isDirectory()) return join(dotgit, "config");
  let body = "";
  try { body = readFileSync(dotgit, "utf8"); } catch { return null; }
  const m = /^gitdir:\s*(.+)$/m.exec(body);
  if (!m) return null;
  const gitdir = resolve(dir, m[1].trim());
  // A worktree's own gitdir holds no config; `commondir` points back to the main .git.
  const common = join(gitdir, "commondir");
  try {
    return join(existsSync(common) ? resolve(gitdir, readFileSync(common, "utf8").trim()) : gitdir, "config");
  } catch { return null; }
}

function originOf(configPath: string): string | null {
  let text: string;
  try { text = readFileSync(configPath, "utf8"); } catch { return null; }
  let inOrigin = false;
  for (const line of text.split("\n")) {
    const sec = /^\s*\[(.+)\]\s*$/.exec(line);
    if (sec) { inOrigin = /^remote\s+"origin"$/.test(sec[1].trim()); continue; }
    const kv = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
    if (inOrigin && kv) return kv[1];
  }
  return null;
}

// Nearest repo's origin, cached per cwd; never walks into $HOME, where a dotfiles repo would claim every session under it.
const remoteCache = new Map<string, string | null>();
export function remoteRepoKey(cwd: string, home = homedir()): string | null {
  if (remoteCache.has(cwd)) return remoteCache.get(cwd)!;
  let key: string | null = null;
  if (existsSync(cwd)) {
    for (let d = cwd; d !== home && d !== dirname(d); d = dirname(d)) {
      const cfg = gitConfigFor(d);
      if (!cfg) continue;
      const url = originOf(cfg);   // the nearest repo decides, origin or not
      key = url ? remoteToKey(url) : null;
      break;
    }
  }
  if (key) key = canonicalRepoKey(key);
  remoteCache.set(cwd, key);
  return key;
}

/**
 * Collapse SIBLING worktrees back into their repo — for SHARDING ONLY.
 *
 * Two conventions exist in this fleet. The current one nests worktrees inside the
 * repo (`my-repo/wt/<slug>`); an older one puts them BESIDE it:
 *
 *   github.com/acme/my-repo.wt-5-some-feature
 *   github.com/acme/my-repo.omx-worktrees
 *
 * Those are one repo and must share one shard — observed for real: `--repo my-repo` produced 17 shards instead of 1 before this existed.
 *
 * The worktree itself is NOT discarded. It is context — which worktree a session ran
 * in says what the work was about — so `contextOf` keeps it as a searchable field.
 *
 * Only these exact markers are stripped: a dot is legal in a repo name, so a blanket
 * "cut at the first dot" would mangle a genuinely-dotted repo.
 */
function normalizeRepo(seg: string): string {
  return seg.replace(/\.(wt-.*|omx-worktrees|worktrees)$/, "");
}

/**
 * The context a session ran in, WITHIN its repo. Worth keeping and filtering on,
 * because a worktree name is usually a statement of intent
 * ("big-refactor-2026-09", "wt-5-some-feature").
 *
 * Covers every layout seen in this corpus:
 *   <repo>/wt/<slug>/...                nested worktree   -> slug
 *   <repo>.wt-5-<slug>/...              sibling worktree  -> wt-5-<slug>
 *   <repo>.omx-worktrees/<slug>/...     omx worktrees     -> <slug>
 *   <repo>/agents/<name>/...            agent workspace   -> agents/<name>
 *   <repo>/ψ/lab/<name>/...             lab              -> lab/<name>
 *   <repo>/...                          main checkout     -> ""
 */
/**
 * The full location hierarchy: org / repo / project / worktree / directory.
 *
 * `repo_key` alone fuses org and repo into one string and drops everything below the
 * worktree, so two genuinely different things collapse onto the same facet. The case
 * that forced this: one oracle's vault contains ANOTHER oracle's entire vault at
 * `ψ/soul-brews-studio/arra-oracle-v3/` — 4,439 notes with their own inbox/memory/
 * learn tree. Keyed on repo alone, every one of them attributes to the HOST repo, so
 * searching arra's memory returns it labelled as neo's.
 *
 * `project` is best-effort and only set where a nested body is unambiguous — a known
 * container segment followed by a name. It is NOT guessed from arbitrary paths:
 * inventing a project for every subdirectory would make the facet noise.
 */
export interface Location {
  org: string;
  repo: string;
  project: string;    // nested oracle/lab/incubated repo, "" when not nested
  worktree: string;
  dir: string;        // path below the worktree — the `subpath` that used to be dropped
}

/** Containers whose NEXT segment names a distinct project living inside a repo. */
const PROJECT_CONTAINERS = new Set(["lab", "soul-brews-studio", "learn", "demos"]);

export function locationOf(cwd: string | null): Location {
  const empty: Location = { org: "", repo: "", project: "", worktree: "", dir: "" };
  if (!cwd) return empty;
  const parts = cwd.split("/").filter(Boolean);
  const gh = hostIndex(parts);
  if (gh < 0 || parts.length < gh + 3) return empty;

  const { worktree, subpath } = contextOf(cwd);
  const seg = subpath.split("/").filter(Boolean);

  // Walk past the vault marker and any worktree segment to find a container.
  let project = "";
  for (let i = 0; i < seg.length - 1; i++) {
    if (PROJECT_CONTAINERS.has(seg[i])) { project = seg[i + 1]; break; }
    // ψ/incubate/<org>/<repo> — the incubated repo is the project, not the org
    if (seg[i] === "incubate" && seg[i + 2]) { project = seg[i + 2]; break; }
  }

  // `dir` is the DIRECTORY below the worktree — not below the repo, and not including
  // the filename. Leaving the worktree segment in would duplicate a facet that already
  // has its own column, and leaving the filename in would make `--dir` match one file
  // instead of a tree.
  let dir = subpath;
  for (const p of [`wt/${worktree}/`, `agents/${worktree}/`]) {
    if (worktree && dir.startsWith(p)) { dir = dir.slice(p.length); break; }
  }
  const slash = dir.lastIndexOf("/");
  dir = slash > 0 ? dir.slice(0, slash) : "";

  return {
    org: parts[gh + 1] ?? "",
    repo: normalizeRepo(parts[gh + 2] ?? ""),
    project,
    worktree,
    dir,
  };
}

export function contextOf(cwd: string | null): { worktree: string; subpath: string } {
  if (!cwd) return { worktree: "", subpath: "" };
  const parts = cwd.split("/").filter(Boolean);
  const gh = hostIndex(parts);
  if (gh < 0 || parts.length < gh + 3) return { worktree: "", subpath: "" };

  const repoSeg = parts[gh + 2];
  const rest = parts.slice(gh + 3);
  const subpath = rest.join("/");

  // sibling conventions carry the worktree in the repo segment itself
  const sib = /^.*?\.(wt-.*|omx-worktrees|worktrees)$/.exec(repoSeg);
  if (sib) {
    const marker = sib[1];
    if (marker.startsWith("wt-")) return { worktree: marker, subpath };
    return { worktree: rest[0] ?? marker, subpath };   // omx-worktrees/<slug>/...
  }

  if (rest[0] === "wt" && rest[1]) return { worktree: rest[1], subpath };
  if (rest[0] === "agents" && rest[1]) return { worktree: `agents/${rest[1]}`, subpath };
  if (rest[0] === "ψ" && rest[1] === "lab" && rest[2]) return { worktree: `lab/${rest[2]}`, subpath };

  return { worktree: "", subpath };
}

let cachedRoot: string | null = null;
export function ghqRoot(): string {
  if (cachedRoot) return cachedRoot;
  try {
    cachedRoot = execSync("ghq root", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    cachedRoot = "/opt/Code";   // fleet default; ghq root differs per machine
  }
  return cachedRoot!;
}

export const SHARD_DIR = ".relic";

/**
 * A BANK is the top level of the shard path — one namespace per source root.
 *
 *   ~/.relic/banks/<bank>/github.com/<org>/<repo>/{events,sessions,files}
 *
 * The three Claude roots are three snapshots of the same machine's history, and they
 * OVERLAP: 742 session uuids appear in two of them, and 455 of 455 of
 * projects-archive's project directories also exist under projects-1sep-tue2026.
 * Merged into one namespace those collide; kept as banks they stay separately
 * addressable, and `uidOf` (which excludes both path and bank, deliberately — see
 * src/types.ts) makes a cross-bank duplicate DETECTABLE rather than silent: the same
 * session in two banks yields the same uid, so a merge can drop one, and a union by
 * uid reconstructs the fullest copy that exists.
 *
 * Used when a caller has no source — a direct `--data-root` read, or a repo-key-only
 * path. Every import path passes the real bank from `bankOf(source)`.
 */
export const DEFAULT_BANK = "default";

/**
 * Banks live under ONE container, never loose at the data root.
 *
 * Without it, "a bank" is defined as "any directory at the top level" — so relic's own
 * trace.jsonl/skipped.jsonl/dig-cache.json are only NOT banks by being files, a renamed
 * bank's leftover directory is still enumerated and searched, and the first cache or
 * vector directory anyone adds becomes a phantom bank with no error anywhere.
 * `ls ~/.relic/banks` IS the bank list.
 */
export const BANKS_DIR = "banks";

/** The default home: ~/.relic/github.com/<org>/<repo>/ — mirrors ghq, touches no repo. */
export function defaultRoot(): string { return join(homedir(), ".relic"); }

/**
 * Where a repo's shard lives.
 *
 * DEFAULT is ~/.relic/<repo-key>/ — the ghq shape, but under $HOME. Nothing is written
 * into a working copy, so there is one place to back up, one place to delete, and no
 * surprise directories in 198 repos you do not own.
 *
 * `inRepo` opts into <ghq-root>/<repo-key>/.relic/ instead, for when an oracle's
 * history should travel with its checkout. `dataRoot` overrides both.
 */
export function shardDirFor(repoKey: string | null, dataRoot: string | null, inRepo = false, bank = DEFAULT_BANK): string {
  const key = repoKey ?? "_unresolved";
  const b = bank || DEFAULT_BANK;
  if (dataRoot) return join(dataRoot, BANKS_DIR, b, key);
  if (inRepo) return repoKey ? join(ghqRoot(), repoKey, SHARD_DIR, BANKS_DIR, b)
                             : join(ghqRoot(), "_relic-unresolved", BANKS_DIR, b);
  return join(defaultRoot(), BANKS_DIR, b, key);
}

/** Self-ignoring, so no repo's own .gitignore is ever edited. */
export function guardShardDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

/** One shard: a repo's tables inside ONE bank. Identity is the pair, not the repo. */
export interface Shard {
  key: string;    // "<bank>/github.com/<org>/<repo>" — display and legacy string matching
  dir: string;
  bank: string;
  repo: string;   // "github.com/<org>/<repo>", or "_unresolved"
}

/**
 * Discover shards by walking the tree — no central manifest to fall out of sync.
 *
 * Three levels now, not two: <bank>/github.com/<org>/<repo>. A pre-bank layout
 * (github.com at the top) yields zero shards rather than an error — there is no
 * migration, because the index is a pure derivative and is rebuilt instead.
 */
export function listShards(dataRoot: string | null, inRepo = false): Shard[] {
  const out: Shard[] = [];
  // `.lance` is a LanceDB TABLE directory. A pre-bank in-repo shard is
  // `<repo>/.relic/{events,sessions,files}.lance`, and without this filter each of those
  // enumerates as a bank whose store opens fine with zero tables — three phantom 0-row
  // shards per legacy repo, inflating every "shards searched" count.
  const banks = (p: string) =>
    listing(p).filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".lance"));

  if (!dataRoot && !inRepo) dataRoot = defaultRoot();

  if (dataRoot) {
    for (const bank of banks(join(dataRoot, BANKS_DIR))) {
      const base = join(dataRoot, BANKS_DIR, bank.name);
      // Every host, as the native binary and the Python port already walk — not only github.com.
      for (const host of banks(base)) {
        if (host.name === "_unresolved") continue;
        const gh = join(base, host.name);
        for (const org of listing(gh)) {
          if (!org.isDirectory()) continue;
          for (const repo of listing(join(gh, org.name))) {
            if (!repo.isDirectory()) continue;
            const key = `${host.name}/${org.name}/${repo.name}`;
            out.push({ key: `${bank.name}/${key}`, dir: join(gh, org.name, repo.name), bank: bank.name, repo: key });
          }
        }
      }
      const un = join(base, "_unresolved");
      if (existsSync(un)) out.push({ key: `${bank.name}/_unresolved`, dir: un, bank: bank.name, repo: "_unresolved" });
    }
    return out;
  }

  const root = ghqRoot();
  // Domain-named dirs only: the ghq root also holds plain checkouts, and walking those two levels deep costs readdirs for nothing.
  for (const host of listing(root).filter(e => e.isDirectory() && e.name.includes(".") && !e.name.startsWith("."))) {
    const gh = join(root, host.name);
    for (const org of listing(gh)) {
      if (!org.isDirectory()) continue;
      for (const repo of listing(join(gh, org.name))) {
        if (!repo.isDirectory()) continue;
        const key = `${host.name}/${org.name}/${repo.name}`;
        // in-repo: the bank sits INSIDE the checkout's .relic/, so one repo can hold
        // several banks without them colliding.
        for (const bank of banks(join(gh, org.name, repo.name, SHARD_DIR, BANKS_DIR)))
          out.push({ key: `${bank.name}/${key}`, dir: join(gh, org.name, repo.name, SHARD_DIR, BANKS_DIR, bank.name), bank: bank.name, repo: key });
      }
    }
  }
  for (const bank of banks(join(root, "_relic-unresolved", BANKS_DIR)))
    out.push({ key: `${bank.name}/_unresolved`, dir: join(root, "_relic-unresolved", BANKS_DIR, bank.name), bank: bank.name, repo: "_unresolved" });
  return out;
}

/**
 * Read a session's working directory from the JSONL itself.
 *
 * THE FILE IS THE SOURCE OF TRUTH for identity. Neither the encoded project dir name
 * (maps both "/" and "." to "-", lossy, not reversible) nor a derived DB column
 * (lanceglass's `project` is "homelab.wt-1-openclaw-guide" — org already gone) can
 * produce a repo key. Both were tried; both were wrong.
 *
 * One read per distinct file, memoised, bounded prefix.
 */
const cwdCache = new Map<string, string | null>();

export async function cwdOfFile(filePath: string): Promise<string | null> {
  if (cwdCache.has(filePath)) return cwdCache.get(filePath)!;
  let found: string | null = null;
  try {
    const head = await Bun.file(filePath).slice(0, 262_144).text();
    for (const line of head.split("\n")) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        const cwd = rec?.cwd ?? rec?.payload?.cwd;
        if (typeof cwd === "string" && cwd) { found = cwd; break; }
      } catch { /* truncated final line is expected when slicing */ }
    }
  } catch { /* unreadable */ }
  cwdCache.set(filePath, found);
  return found;
}
