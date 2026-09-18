import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadSources } from "./sources.js";

/**
 * What is running RIGHT NOW — answered from the filesystem, never from the index.
 *
 * The index is always behind live work by definition: a transcript is being appended to
 * while it is being read, and an import that just ran cannot include the line written a
 * second later. So liveness here is mtime, which is exactly as fresh as the work itself.
 *
 * This is the one part of relic that deliberately does NOT consult LanceDB.
 */

/** Seconds since a file was last written. */
const age = (mtimeMs: number) => Math.max(0, Math.round((Date.now() - mtimeMs) / 1000));

/**
 * cwd -> project directory name.
 *
 * DECODING this is lossy — both "/" and "." map to "-", so the reverse is ambiguous and
 * relic never does it. ENCODING is deterministic, which is what makes "which session am
 * I in" a lookup rather than a search: compute the directory, read the newest file in it.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, "-");
}

/**
 * omp encodes a cwd differently, and the difference is silent if you assume otherwise.
 *
 *   Claude  /opt/Code/github.com/x  ->  -opt-Code-github-com-x     ('/' AND '.' -> '-')
 *   omp     /opt/Code/github.com/x  ->  --opt-Code-github.com-x--  ('/' -> '-', dots KEPT,
 *                                                                   wrapped in '--')
 *
 * Verified against a real directory on disk rather than inferred. Using Claude's encoder
 * on an omp root silently matches nothing — existsSync just returns false and the source
 * is skipped, which looks identical to "omp has no session here".
 */
export function encodeOmpDir(cwd: string): string {
  return "--" + cwd.split("/").filter(Boolean).join("-") + "--";
}

/** The directory name a given source would use for this cwd. */
function encodeFor(walk: string, cwd: string): string {
  return walk === "omp" ? encodeOmpDir(cwd) : encodeProjectDir(cwd);
}

/**
 * omp filenames are <timestamp>_<id>.jsonl; the id after the underscore is the session
 * identity that its own `session` record carries. Claude's filename IS the uuid.
 */
function uuidFromFile(walk: string, fileName: string): string {
  const base = fileName.replace(/\.jsonl$/, "");
  if (walk !== "omp") return base;
  const i = base.indexOf("_");
  return i >= 0 ? base.slice(i + 1) : base;
}

export interface LiveFile {
  path: string;
  tier: "session" | "subagent" | "workflow_agent";
  sessionUuid: string;
  agentId: string | null;
  workflowRunId: string | null;
  mtimeMs: number;
  ageSec: number;
  size: number;
}

function jsonlIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name);
  } catch { return []; }
}
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}
function statOf(p: string) {
  try { const s = statSync(p); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
}

/**
 * Every transcript belonging to one session tree, with its age.
 *
 * `journal.jsonl` is excluded: a workflow directory holds one, it is bookkeeping rather
 * than a transcript, and it would otherwise show up as an "agent" with no events.
 */
export function treeFiles(projectDir: string, sessionUuid: string): LiveFile[] {
  const out: LiveFile[] = [];
  const parent = join(projectDir, `${sessionUuid}.jsonl`);
  const ps = statOf(parent);
  if (ps) out.push({ path: parent, tier: "session", sessionUuid, agentId: null,
                     workflowRunId: null, ageSec: age(ps.mtimeMs), ...ps });

  const sub = join(projectDir, sessionUuid, "subagents");
  for (const f of jsonlIn(sub)) {
    const st = statOf(join(sub, f));
    if (st) out.push({ path: join(sub, f), tier: "subagent", sessionUuid,
                       agentId: basename(f, ".jsonl"), workflowRunId: null, ageSec: age(st.mtimeMs), ...st });
  }
  const wf = join(sub, "workflows");
  for (const run of subdirs(wf)) {
    if (!run.startsWith("wf_")) continue;
    for (const f of jsonlIn(join(wf, run))) {
      if (f === "journal.jsonl") continue;
      const st = statOf(join(wf, run, f));
      if (st) out.push({ path: join(wf, run, f), tier: "workflow_agent", sessionUuid,
                         agentId: basename(f, ".jsonl"), workflowRunId: run, ageSec: age(st.mtimeMs), ...st });
    }
  }
  out.sort((a, b) => a.ageSec - b.ageSec);
  return out;
}

export interface CurrentSession {
  sessionUuid: string;
  projectDir: string;
  path: string;
  cwd: string;
  title: string | null;
  ageSec: number;
  confident: boolean;   // false when the transcript's own cwd did not match
}

/** Read just the fields needed to identify a transcript, without parsing all of it. */
async function peek(path: string, maxLines = 400): Promise<{ cwd: string | null; title: string | null }> {
  let cwd: string | null = null, title: string | null = null, n = 0;
  try {
    const rl = createInterface({ input: createReadStream(path, "utf8") });
    for await (const line of rl) {
      if (!line.trim()) continue;
      if (++n > maxLines) break;
      try {
        const r = JSON.parse(line);
        if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
        // Claude writes {type:"ai-title", aiTitle}; omp writes {type:"title"|"title_change", title}.
        if (r.type === "ai-title" && typeof r.aiTitle === "string") title = r.aiTitle;
        if ((r.type === "title" || r.type === "title_change") && typeof r.title === "string") title = r.title;
      } catch { /* a half-written line on a live file is normal */ }
    }
    rl.close();
  } catch { /* unreadable is not fatal — the caller degrades to "unknown" */ }
  return { cwd, title };
}

/**
 * Which session is running in `cwd` — the newest transcript in the matching project dir.
 *
 * Newest-by-mtime is the whole heuristic, and it is correct for the common case by
 * construction: the session being written to right now is the one that was written to
 * most recently. It is verified against the transcript's own `cwd` field, and reports
 * `confident: false` rather than lying when they disagree — two checkouts can encode to
 * the same directory name, since the encoding is not injective.
 */
export async function currentSession(cwd = process.cwd()): Promise<CurrentSession | null> {
  // Walk UP from cwd. A session's project directory is keyed on the directory the agent
  // was started in — usually a repo root — so running this from a subdirectory would
  // otherwise report "no session" while sitting inside one. Nearest match wins.
  const candidates: string[] = [];
  for (let d = cwd; ; ) {
    candidates.push(d);
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }

  for (const cand of candidates) {
    const hit = await sessionIn(cand, cwd);
    if (hit) return hit;
  }
  return null;
}

async function sessionIn(cand: string, cwd: string): Promise<CurrentSession | null> {
  // Collect from EVERY source, then take the globally newest — do not return the first
  // source that happens to have a directory for this cwd.
  //
  // Returning first-match meant source ORDER decided the answer: claude-live is first in
  // the builtin list, so an omp agent asking "which session am I in" got the newest
  // CLAUDE transcript in the same worktree — a different agent's conversation — every
  // single time, with no error to notice. Observed live: omp got 04d1d650 back, which
  // was the lead Claude session actively writing beside it.
  let best: { uuid: string; path: string; mtimeMs: number; dir: string } | null = null;

  for (const src of loadSources()) {
    if (src.walk === "flat") continue;              // Codex has no project-dir layout
    const dir = join(src.path, encodeFor(src.walk, cand));
    if (!existsSync(dir)) continue;

    for (const f of jsonlIn(dir)) {
      const st = statOf(join(dir, f));
      if (!st) continue;
      if (best && st.mtimeMs <= best.mtimeMs) continue;
      best = { uuid: uuidFromFile(src.walk, f), path: join(dir, f), mtimeMs: st.mtimeMs, dir };
    }
  }
  if (!best) return null;

  const { cwd: own, title } = await peek(best.path);
  return { sessionUuid: best.uuid, projectDir: best.dir, path: best.path,
           cwd: own ?? cand, title, ageSec: age(best.mtimeMs),
           // The transcript's own cwd is the authority. It matches the directory we
           // walked up to, not necessarily the one the caller is standing in.
           confident: own === cand };
}

export interface LiveSession {
  sessionUuid: string;
  projectDir: string;
  cwd: string | null;
  title: string | null;
  files: LiveFile[];      // only those inside the window
  ageSec: number;         // freshest write in the tree
  agents: number;         // live children
}

/**
 * The optional native binary, for the one thing it is genuinely better at.
 *
 * The scan below is thousands of `stat()` calls over ~1,500 project directories, and
 * it is the whole cost of this function — measured: resolving ONE session is 1 ms,
 * this sweep is 200+ ms. It is also pure syscalls, so it parallelises across threads,
 * which this runtime cannot do for blocking fs calls.
 *
 * What the binary is NOT asked to do is build the result. It returns fresh CANDIDATES
 * — project directory plus uuids — and everything after that (reading each transcript
 * head for cwd and title, assembling the tree) stays here, in one place. A second
 * implementation of an output format is a second thing to drift; a second
 * implementation of `readdir` is not.
 *
 * Absent, unbuildable, slow, or wrong shape -> null, and the caller scans in-process.
 * The binary is strictly optional: `bunx` must keep working with no Rust toolchain.
 * Set RELIC_NATIVE=0 to force the TypeScript path, or RELIC_NATIVE=/path/to/binary.
 */
function nativeBin(): string | null {
  const env = process.env.RELIC_NATIVE;
  if (env === "0" || env === "false") return null;
  if (env) return existsSync(env) ? env : null;
  try {
    const here = dirname(fileURLToPath(import.meta.url));           // <repo>/src
    const p = join(here, "..", "rust", "target", "release", "relic-native");
    return existsSync(p) ? p : null;
  } catch { return null; }
}

type FreshMap = { project: string; uuids: string[] }[];

/**
 * Why the binary is or is not being used — for `relic backend`.
 *
 * "Is it faster" is the second question. The first is "is it even running", and
 * before this existed the only way to find out was to read the source: an unbuilt
 * binary, a stale RELIC_NATIVE, and a working native path all looked identical from
 * the outside, because the fallback is silent by design.
 */
export function nativeInfo(): { path: string | null; usable: boolean; reason: string } {
  const env = process.env.RELIC_NATIVE;
  if (env === "0" || env === "false")
    return { path: null, usable: false, reason: "disabled by RELIC_NATIVE=0" };
  if (env)
    return existsSync(env)
      ? { path: env, usable: true, reason: "set by RELIC_NATIVE" }
      : { path: env, usable: false, reason: "RELIC_NATIVE points at a missing file" };
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "..",
                   "rust", "target", "release", "relic-native");
    return existsSync(p)
      ? { path: p, usable: true, reason: "auto-detected" }
      : { path: p, usable: false, reason: "not built — cargo build --release --manifest-path rust/Cargo.toml" };
  } catch {
    return { path: null, usable: false, reason: "could not resolve module path" };
  }
}

async function nativeFresh(roots: string[], windowSec: number): Promise<FreshMap | null> {
  const bin = nativeBin();
  if (!bin || !roots.length) return null;
  try {
    const proc = Bun.spawn([bin, "live", "--window", String(windowSec), "--", ...roots],
                           { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    if ((await proc.exited) !== 0) return null;
    const parsed = JSON.parse(out);
    // Shape-check rather than trust: a future binary that changes this format must
    // fall back, not feed half-built objects into the loop below.
    if (!Array.isArray(parsed)) return null;
    for (const x of parsed) {
      if (typeof x?.project !== "string" || !Array.isArray(x?.uuids)) return null;
    }
    return parsed as FreshMap;
  } catch { return null; }
}

/** The same sweep, in-process. The reference path, and the fallback. */
function tsFresh(roots: string[], windowSec: number): FreshMap {
  const out: FreshMap = [];
  for (const root of roots) {
    for (const project of subdirs(root)) {
      const pdir = join(root, project);
      const fresh: string[] = [];
      for (const f of jsonlIn(pdir)) {
        const st = statOf(join(pdir, f));
        if (st && age(st.mtimeMs) <= windowSec) fresh.push(basename(f, ".jsonl"));
      }
      for (const d of subdirs(pdir)) {
        const st = statOf(join(pdir, d, "subagents"));
        if (st && age(st.mtimeMs) <= windowSec && !fresh.includes(d)) fresh.push(d);
      }
      if (fresh.length) out.push({ project: pdir, uuids: fresh });
    }
  }
  return out;
}

/**
 * Roots to sweep: transcript layouts only, each path once.
 *
 * Exported because it is the input both the native and the in-process scan receive,
 * and a test that compares the two must hand them the same list.
 */
export function liveRoots(): string[] {
  const seen = new Set<string>();
  for (const src of loadSources()) {
    if (src.walk !== "claude-tiers" && src.walk !== "omp") continue;
    if (!existsSync(src.path)) continue;
    seen.add(src.path);
  }
  return [...seen];
}

export async function freshCandidates(roots: string[], windowSec: number): Promise<FreshMap> {
  return (await nativeFresh(roots, windowSec)) ?? tsFresh(roots, windowSec);
}

/**
 * Every session written to in the last `windowSec`, across all configured sources.
 *
 * This is the `/list-agents` question asked of the filesystem: an agent that is running
 * is an agent whose transcript is growing. It scans project directories one level deep
 * — bounded, never a tree walk — because a stale project directory costs one readdir.
 */
export async function liveSessions(windowSec = 300, limit = 20): Promise<LiveSession[]> {
  const found: LiveSession[] = [];

  // One sweep, two possible engines, identical result. Everything after the sweep
  // runs here regardless of which engine produced the candidates.
  for (const { project: pdir, uuids } of await freshCandidates(liveRoots(), windowSec)) {
    for (const uuid of uuids) {
      const files = treeFiles(pdir, uuid).filter(f => f.ageSec <= windowSec);
      if (!files.length) continue;
      const { cwd, title } = await peek(join(pdir, `${uuid}.jsonl`));
      found.push({ sessionUuid: uuid, projectDir: pdir, cwd, title, files,
                   ageSec: Math.min(...files.map(f => f.ageSec)),
                   agents: files.filter(f => f.tier !== "session").length });
    }
  }
  found.sort((a, b) => a.ageSec - b.ageSec);
  return found.slice(0, limit);
}

/**
 * Writes per time bucket over the recent past — a sparkline of when work happened.
 *
 * Built from mtime, so it shows the LAST write to each transcript rather than every
 * event. That makes it a map of activity, not of volume, which is the right shape for
 * "was anything happening at 16:40" and the wrong one for "how much".
 */
export function activityBuckets(files: LiveFile[], minutes = 60, buckets = 30):
  { startMs: number; endMs: number; counts: number[]; perBucketMin: number } {
  const endMs = Date.now();
  const startMs = endMs - minutes * 60_000;
  const counts = new Array(buckets).fill(0);
  const width = (endMs - startMs) / buckets;
  for (const f of files) {
    if (f.mtimeMs < startMs) continue;
    const i = Math.min(buckets - 1, Math.floor((f.mtimeMs - startMs) / width));
    counts[i]++;
  }
  return { startMs, endMs, counts, perBucketMin: minutes / buckets };
}

const BLOCKS = " ▁▂▃▄▅▆▇█";
export function sparkline(counts: number[]): string {
  const max = Math.max(...counts, 1);
  return counts.map(c => BLOCKS[c === 0 ? 0 : Math.max(1, Math.round((c / max) * (BLOCKS.length - 1)))]).join("");
}

export function humanAge(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}
