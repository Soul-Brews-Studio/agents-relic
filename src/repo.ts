import { execSync } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

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
export function repoKeyOf(cwd: string | null): string | null {
  if (!cwd) return null;
  const parts = cwd.split("/").filter(Boolean);

  const gh = parts.indexOf("github.com");
  if (gh >= 0 && parts.length >= gh + 3) return `github.com/${parts[gh + 1]}/${normalizeRepo(parts[gh + 2])}`;

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
export function repoIndex(): Map<string, string[]> {
  if (repoIndexCache) return repoIndexCache;
  const out = new Map<string, string[]>();
  const host = join(ghqRoot(), "github.com");
  try {
    for (const org of readdirSync(host, { withFileTypes: true })) {
      if (!org.isDirectory()) continue;
      for (const repo of readdirSync(join(host, org.name), { withFileTypes: true })) {
        if (!repo.isDirectory()) continue;
        const name = normalizeRepo(repo.name);
        const key = `github.com/${org.name}/${name}`;
        const prior = out.get(name) ?? [];
        if (!prior.includes(key)) prior.push(key);
        out.set(name, prior);
      }
    }
  } catch { /* no ghq root here — the fallbacks simply never fire */ }
  repoIndexCache = out;
  return out;
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
export function resolveRepoKey(cwd: string | null): string | null {
  const direct = repoKeyOf(cwd);
  if (direct || !cwd) return direct;
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
  return null;
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
  const gh = parts.indexOf("github.com");
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
  const gh = parts.indexOf("github.com");
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
  const ls = (p: string) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };
  // `.lance` is a LanceDB TABLE directory. A pre-bank in-repo shard is
  // `<repo>/.relic/{events,sessions,files}.lance`, and without this filter each of those
  // enumerates as a bank whose store opens fine with zero tables — three phantom 0-row
  // shards per legacy repo, inflating every "shards searched" count.
  const banks = (p: string) =>
    ls(p).filter(e => e.isDirectory() && !e.name.startsWith(".") && !e.name.endsWith(".lance"));

  if (!dataRoot && !inRepo) dataRoot = defaultRoot();

  if (dataRoot) {
    for (const bank of banks(join(dataRoot, BANKS_DIR))) {
      const base = join(dataRoot, BANKS_DIR, bank.name);
      const gh = join(base, "github.com");
      for (const org of ls(gh)) {
        if (!org.isDirectory()) continue;
        for (const repo of ls(join(gh, org.name))) {
          if (!repo.isDirectory()) continue;
          const key = `github.com/${org.name}/${repo.name}`;
          out.push({ key: `${bank.name}/${key}`, dir: join(gh, org.name, repo.name), bank: bank.name, repo: key });
        }
      }
      const un = join(base, "_unresolved");
      if (existsSync(un)) out.push({ key: `${bank.name}/_unresolved`, dir: un, bank: bank.name, repo: "_unresolved" });
    }
    return out;
  }

  const root = ghqRoot();
  const gh = join(root, "github.com");
  for (const org of ls(gh)) {
    if (!org.isDirectory()) continue;
    for (const repo of ls(join(gh, org.name))) {
      if (!repo.isDirectory()) continue;
      const key = `github.com/${org.name}/${repo.name}`;
      // in-repo: the bank sits INSIDE the checkout's .relic/, so one repo can hold
      // several banks without them colliding.
      for (const bank of banks(join(gh, org.name, repo.name, SHARD_DIR, BANKS_DIR)))
        out.push({ key: `${bank.name}/${key}`, dir: join(gh, org.name, repo.name, SHARD_DIR, BANKS_DIR, bank.name), bank: bank.name, repo: key });
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
