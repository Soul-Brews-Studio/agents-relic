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
export function shardDirFor(repoKey: string | null, dataRoot: string | null, inRepo = false): string {
  const key = repoKey ?? "_unresolved";
  if (dataRoot) return join(dataRoot, key);
  if (inRepo) return repoKey ? join(ghqRoot(), repoKey, SHARD_DIR) : join(ghqRoot(), "_relic-unresolved");
  return join(defaultRoot(), key);
}

/** Self-ignoring, so no repo's own .gitignore is ever edited. */
export function guardShardDir(dir: string) {
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
}

/** Discover shards by walking the tree — no central manifest to fall out of sync. */
export function listShards(dataRoot: string | null, inRepo = false): { key: string; dir: string }[] {
  const out: { key: string; dir: string }[] = [];
  const ls = (p: string) => { try { return readdirSync(p, { withFileTypes: true }); } catch { return []; } };

  if (!dataRoot && !inRepo) dataRoot = defaultRoot();

  if (dataRoot) {
    const gh = join(dataRoot, "github.com");
    for (const org of ls(gh)) {
      if (!org.isDirectory()) continue;
      for (const repo of ls(join(gh, org.name))) {
        if (!repo.isDirectory()) continue;
        out.push({ key: `github.com/${org.name}/${repo.name}`, dir: join(gh, org.name, repo.name) });
      }
    }
    const un = join(dataRoot, "_unresolved");
    if (existsSync(un)) out.push({ key: "_unresolved", dir: un });
    return out;
  }

  const root = ghqRoot();
  const gh = join(root, "github.com");
  for (const org of ls(gh)) {
    if (!org.isDirectory()) continue;
    for (const repo of ls(join(gh, org.name))) {
      if (!repo.isDirectory()) continue;
      const dir = join(gh, org.name, repo.name, SHARD_DIR);
      if (existsSync(dir)) out.push({ key: `github.com/${org.name}/${repo.name}`, dir });
    }
  }
  const un = join(root, "_relic-unresolved");
  if (existsSync(un)) out.push({ key: "_unresolved", dir: un });
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
