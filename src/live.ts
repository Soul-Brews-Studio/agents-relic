import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
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
        if (r.type === "ai-title" && typeof r.aiTitle === "string") title = r.aiTitle;
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
  const want = encodeProjectDir(cand);
  for (const src of loadSources()) {
    if (src.walk === "flat") continue;              // Codex has no project-dir layout
    const dir = join(src.path, want);
    if (!existsSync(dir)) continue;

    let best: { uuid: string; path: string; mtimeMs: number } | null = null;
    for (const f of jsonlIn(dir)) {
      const st = statOf(join(dir, f));
      if (st && (!best || st.mtimeMs > best.mtimeMs))
        best = { uuid: basename(f, ".jsonl"), path: join(dir, f), mtimeMs: st.mtimeMs };
    }
    if (!best) continue;

    const { cwd: own, title } = await peek(best.path);
    return { sessionUuid: best.uuid, projectDir: dir, path: best.path,
             cwd: own ?? cand, title, ageSec: age(best.mtimeMs),
             // The transcript's own cwd is the authority. It matches the directory we
             // walked up to, not necessarily the one the caller is standing in.
             confident: own === cand };
  }
  return null;
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
 * Every session written to in the last `windowSec`, across all configured sources.
 *
 * This is the `/list-agents` question asked of the filesystem: an agent that is running
 * is an agent whose transcript is growing. It scans project directories one level deep
 * — bounded, never a tree walk — because a stale project directory costs one readdir.
 */
export async function liveSessions(windowSec = 300, limit = 20): Promise<LiveSession[]> {
  const found: LiveSession[] = [];

  for (const src of loadSources()) {
    if (src.walk === "flat") continue;
    for (const project of subdirs(src.path)) {
      const pdir = join(src.path, project);

      // Cheap gate first: if no top-level transcript is fresh, skip the tree entirely.
      // Children live under <uuid>/, and a child write bumps the parent in practice —
      // but not always, so also check session directories whose own mtime is fresh.
      const fresh: string[] = [];
      for (const f of jsonlIn(pdir)) {
        const st = statOf(join(pdir, f));
        if (st && age(st.mtimeMs) <= windowSec) fresh.push(basename(f, ".jsonl"));
      }
      for (const d of subdirs(pdir)) {
        const st = statOf(join(pdir, d, "subagents"));
        if (st && age(st.mtimeMs) <= windowSec && !fresh.includes(d)) fresh.push(d);
      }
      if (!fresh.length) continue;

      for (const uuid of fresh) {
        const files = treeFiles(pdir, uuid).filter(f => f.ageSec <= windowSec);
        if (!files.length) continue;
        const { cwd, title } = await peek(join(pdir, `${uuid}.jsonl`));
        found.push({ sessionUuid: uuid, projectDir: pdir, cwd, title, files,
                     ageSec: Math.min(...files.map(f => f.ageSec)),
                     agents: files.filter(f => f.tier !== "session").length });
      }
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
