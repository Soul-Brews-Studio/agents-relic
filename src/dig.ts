import { existsSync, statSync, readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { parseClaude } from "./shapes/claude.js";
import { resolveRepoKey, repoKeyOf } from "./repo.js";
import { loadSources } from "./sources.js";
import { localDateTime } from "./time.js";
import { defaultRoot } from "./repo.js";

/**
 * `dig` — the fleet's session-timeline scan, with the tier it was missing.
 *
 * This emits the SAME JSON contract as ~/.claude/skills/dig/scripts/dig.py: an array of
 * session entries in start order, gap sentinels interleaved, and a trailing coverage
 * entry in deep mode. The /dig skill's renderer keeps working unchanged.
 *
 * Three measured differences from the Python:
 *
 *   1. WORKFLOW AGENTS. dig.py --deep globs `<uuid>/subagents` for .jsonl and never
 *      descends into the `subagents/workflows/wf_...` directories. In one real session that is 105 of
 *      117 transcripts — a fan-out is invisible to it.
 *
 *   2. gitBranch. dig.py takes it only from a `type:"summary"` record. Sampled over the
 *      120 newest transcripts across both roots: summary records 0/120, `gitBranch` on
 *      ordinary records 120/120. So its branch column reads "unknown" for every current
 *      session while the value sits on every line.
 *
 *   3. sessions-index.json, its other metadata source, exists in 59 of 1,527 project
 *      directories (3.9%).
 *
 * What it does NOT change: the scan is still over FILES, not the index. dig answers
 * "what happened recently" over whatever is on disk, including transcripts nothing has
 * imported yet, and making it depend on an index would narrow that.
 */

export interface DigEntry {
  sessionId: string; repoName: string;
  startGMT7: string; endGMT7: string; durationMin: number;
  realHumanMessages: number; assistantMessages: number;
  firstPrompt: string | null; gitBranch: string; summary: string;
  isSidechain: boolean;
  toolCalls?: number; fileSizeKB?: number; isSubagent?: boolean;
  tier?: string; workflowRunId?: string | null;
}
export type DigRow = DigEntry | { type: "gap"; gapMin?: number; label: string } | Record<string, unknown>;

const GAP_THRESHOLD_MIN = 30;

function jsonlIn(d: string): string[] {
  try {
    return readdirSync(d, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name);
  } catch { return []; }
}
function dirsIn(d: string): string[] {
  try {
    return readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}

interface Cand { path: string; dir: string; tier: string; run: string | null }

/**
 * Collect candidates across all THREE tiers.
 *
 * Every path is existsSync'd before it is stat'd. Archived roots are full of symlinks
 * into the live root, and those dangle the moment a session is pruned there — dig.py
 * records an incident where one bad link aborted a scan of 38,764 files and emitted
 * zero sessions, which reads as "no history". The same thing broke a probe written
 * while building this.
 */
function collect(projectDirs: string[], deep: boolean): { files: Cand[]; skipped: number } {
  const files: Cand[] = [];
  let skipped = 0;
  const keep = (c: Cand) => {
    if (!existsSync(c.path)) { skipped++; return; }
    try { if (statSync(c.path).size > 0) files.push(c); else skipped++; }
    catch { skipped++; }
  };

  for (const d of projectDirs) {
    for (const f of jsonlIn(d)) keep({ path: join(d, f), dir: d, tier: "session", run: null });
    if (!deep) continue;

    for (const uuid of dirsIn(d)) {
      const sub = join(d, uuid, "subagents");
      if (!existsSync(sub)) continue;
      for (const f of jsonlIn(sub)) keep({ path: join(sub, f), dir: d, tier: "subagent", run: null });

      // THE MISSING TIER.
      const wf = join(sub, "workflows");
      for (const run of dirsIn(wf)) {
        if (!run.startsWith("wf_")) continue;
        for (const f of jsonlIn(join(wf, run))) {
          if (f === "journal.jsonl") continue;   // bookkeeping, not a transcript
          keep({ path: join(wf, run, f), dir: d, tier: "workflow_agent", run });
        }
      }
    }
  }
  return { files, skipped };
}

// dig's field names say GMT7, so local was always right here — it was the OTHER
// commands that disagreed. Same formatter now, so they cannot drift again.
const toLocal = localDateTime;

function repoNameOf(cwd: string | null, dir: string): string {
  // The session's own cwd, never the encoded directory name — that encoding maps both
  // "/" and "." to "-", so reversing it is guesswork. dig.py reverses it and then
  // repairs the result with a `ghq list -p` subprocess on every invocation.
  const key = resolveRepoKey(cwd);
  if (key) return key.split("/").pop()!;
  return basename(dir).replace(/-(wt|agents)-.*$/, "").split("-").pop() || basename(dir);
}


/**
 * Parsed-facts cache. A finished transcript never changes, so never parse it twice.
 *
 * Measured before this existed: enumeration of 37,496 candidates across 1,527 project
 * directories costs 0.82 s FIXED, and every transcript parsed after that costs ~11 ms.
 * `relic dig 1000 --deep` was 12.0 s, of which 11.2 s was re-reading files whose bytes
 * had not moved since the last run.
 *
 * The key is (path, mtime, size) — the same import-diff identity the index uses, and the
 * same one dig.py trusts for dedup. No content hashing: hashing 56 MB to avoid parsing
 * 56 MB saves nothing.
 *
 * What is cached is the RAW facts, never the rendered row. startGMT7/endGMT7 are local
 * strings, so caching those would bake the machine's timezone into the file and survive
 * a TZ change as a wrong answer — the exact shape of bug this session spent an hour
 * finding elsewhere. ISO in, formatted on the way out.
 */
interface CacheRec {
  m: number; s: number;                  // mtime seconds, size bytes — the identity
  sid: string; cwd: string | null; branch: string | null;
  start: string; end: string;            // ISO, always UTC
  human: number; asst: number; tools: number;
  first: string | null; name: string;
}
type CacheMap = Record<string, CacheRec>;

function cachePath(dataRoot?: string | null): string {
  return join(dataRoot ?? defaultRoot(), "dig-cache.json");
}

function loadCache(dataRoot?: string | null): CacheMap {
  try { return JSON.parse(readFileSync(cachePath(dataRoot), "utf8")) as CacheMap; }
  catch { return {}; }   // absent or corrupt is not an error — it is a cold cache
}

function saveCache(c: CacheMap, dataRoot?: string | null): void {
  try {
    const p = cachePath(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    // Write-then-rename: two dig runs can overlap, and a half-written cache that still
    // parses as JSON is worse than no cache — it would serve truncated facts silently.
    const tmp = `${p}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(c));
    renameSync(tmp, p);
  } catch { /* an unwritable cache must never fail a dig */ }
}

export interface DigOpts { projectDirs?: string[]; count?: number; deep?: boolean;
                           dataRoot?: string | null; noCache?: boolean }

export async function dig(o: DigOpts = {}): Promise<DigRow[]> {
  const projectDirs = o.projectDirs?.length ? o.projectDirs : defaultProjectDirs();
  const deep = Boolean(o.deep);
  const count = o.count ?? 10;

  const { files, skipped } = collect(projectDirs, deep);
  const totalFound = files.length;

  // Newest first, then cut — so a count limits the scan, not just the output.
  const byMtime = files
    .map(c => { try { return { c, m: statSync(c.path).mtimeMs }; } catch { return null; } })
    .filter(Boolean) as { c: Cand; m: number }[];
  byMtime.sort((a, b) => b.m - a.m);
  const chosen = count > 0 ? byMtime.slice(0, count) : byMtime;

  const cache = o.noCache ? {} : loadCache(o.dataRoot);
  let hits = 0, misses = 0;

  const sessions: DigEntry[] = [];
  for (const { c } of chosen) {
    let st;
    try { st = statSync(c.path); } catch { continue; }
    const mtime = Math.floor(st.mtimeMs / 1000), size = st.size;

    let rec = cache[c.path];
    if (rec && rec.m === mtime && rec.s === size) {
      hits++;
    } else {
      misses++;
      let p;
      try { p = await parseClaude(c.path); } catch { continue; }
      if (!p.startedAt) continue;

      // "Real" human messages: dig.py's own rule — a user-role event with more than five
      // characters that is not an interrupt marker. Kept verbatim so the two agree.
      const human = p.events.filter(e => e.role === "user" && e.text.trim().length > 5
                                      && !e.text.startsWith("[Request interrupted"));
      rec = {
        m: mtime, s: size,
        sid: basename(c.path, ".jsonl").slice(0, 12),
        cwd: p.cwd, branch: p.gitBranch,
        start: p.startedAt, end: p.endedAt ?? p.startedAt,
        human: human.length,
        asst: p.events.filter(e => e.role === "assistant").length,
        tools: p.events.filter(e => e.role === "tool_use").length,
        first: human[0]?.text.slice(0, 80) ?? null,
        name: (p.title || p.description || human[0]?.text || "No summary").slice(0, 80),
      };
      cache[c.path] = rec;
    }

    const dur = Math.max(0, Math.round((Date.parse(rec.end) - Date.parse(rec.start)) / 60000)) || 0;
    const entry: DigEntry = {
      sessionId: rec.sid,
      repoName: repoNameOf(rec.cwd, c.dir),
      startGMT7: toLocal(rec.start),
      endGMT7: toLocal(rec.end),
      durationMin: dur,
      realHumanMessages: rec.human,
      assistantMessages: rec.asst,
      firstPrompt: rec.first,
      gitBranch: rec.branch || "unknown",
      summary: rec.name,
      isSidechain: c.tier !== "session",
    };
    if (deep) {
      entry.toolCalls = rec.tools;
      entry.fileSizeKB = Math.floor(size / 1024);
      entry.isSubagent = c.tier !== "session";
      entry.tier = c.tier;                 // NEW: which of the three, not just yes/no
      entry.workflowRunId = c.run;         // NEW: groups a fan-out back together
    }
    sessions.push(entry);
  }

  if (!o.noCache && misses) saveCache(cache, o.dataRoot);

  sessions.sort((a, b) => a.startGMT7.localeCompare(b.startGMT7));

  // Gap sentinels — the shape the /dig renderer expects around each session.
  const out: DigRow[] = [];
  for (let i = 0; i < sessions.length; i++) {
    if (i === 0) out.push({ type: "gap", label: "sleeping / offline" });
    else {
      const prev = Date.parse(sessions[i - 1].endGMT7.replace(" ", "T"));
      const cur = Date.parse(sessions[i].startGMT7.replace(" ", "T"));
      const gap = Math.round((cur - prev) / 60000);
      if (Number.isFinite(gap) && gap > GAP_THRESHOLD_MIN)
        out.push({ type: "gap", gapMin: gap, label: `${gap}m gap` });
    }
    out.push(sessions[i]);
  }
  out.push({ type: "gap", label: "no session yet" });

  if (deep) {
    const tiers: Record<string, number> = {};
    for (const s of sessions) tiers[s.tier ?? "session"] = (tiers[s.tier ?? "session"] ?? 0) + 1;
    out.push({
      type: "coverage", totalFound, skippedUnreadable: skipped,
      corpusRoots: [...new Set(projectDirs.map(d => join(d, "..")))].sort(),
      returned: sessions.length, deep, includeSubagents: deep,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      projectDirs: projectDirs.length,
      tiers,                                   // NEW: proves the third tier was scanned
      scanner: "agents-relic",
      cache: { hits, misses, path: o.noCache ? null : cachePath(o.dataRoot) },
    });
  }
  return out;
}

/** Every project directory under every configured Claude source. */
export function defaultProjectDirs(): string[] {
  const out: string[] = [];
  for (const src of loadSources()) {
    if (src.walk === "flat") continue;
    for (const d of dirsIn(src.path)) out.push(join(src.path, d));
  }
  return out;
}
