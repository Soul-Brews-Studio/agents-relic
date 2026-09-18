import { existsSync, statSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { parseClaude } from "./shapes/claude.js";
import { repoKeyOf } from "./repo.js";
import { loadSources } from "./sources.js";

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

/** Local-time formatter. TZ is honoured by the runtime; dig.py rolled its own. */
function toLocal(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function repoNameOf(cwd: string | null, dir: string): string {
  // The session's own cwd, never the encoded directory name — that encoding maps both
  // "/" and "." to "-", so reversing it is guesswork. dig.py reverses it and then
  // repairs the result with a `ghq list -p` subprocess on every invocation.
  const key = repoKeyOf(cwd);
  if (key) return key.split("/").pop()!;
  return basename(dir).replace(/-(wt|agents)-.*$/, "").split("-").pop() || basename(dir);
}

export interface DigOpts { projectDirs?: string[]; count?: number; deep?: boolean }

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

  const sessions: DigEntry[] = [];
  for (const { c } of chosen) {
    let p;
    try { p = await parseClaude(c.path); } catch { continue; }
    if (!p.startedAt) continue;

    // "Real" human messages: dig.py's own rule — a user-role event with more than five
    // characters that is not an interrupt marker. Kept verbatim so the two agree.
    const human = p.events.filter(e => e.role === "user" && e.text.trim().length > 5
                                    && !e.text.startsWith("[Request interrupted"));
    const assistant = p.events.filter(e => e.role === "assistant").length;
    const toolCalls = p.events.filter(e => e.role === "tool_use").length;

    const dur = p.endedAt
      ? Math.max(0, Math.round((Date.parse(p.endedAt) - Date.parse(p.startedAt)) / 60000)) : 0;

    const entry: DigEntry = {
      sessionId: basename(c.path, ".jsonl").slice(0, 12),
      repoName: repoNameOf(p.cwd, c.dir),
      startGMT7: toLocal(p.startedAt),
      endGMT7: toLocal(p.endedAt ?? p.startedAt),
      durationMin: dur,
      realHumanMessages: human.length,
      assistantMessages: assistant,
      firstPrompt: human[0]?.text.slice(0, 80) ?? null,
      gitBranch: p.gitBranch || "unknown",
      summary: (p.title || p.description || human[0]?.text || "No summary").slice(0, 80),
      isSidechain: c.tier !== "session",
    };
    if (deep) {
      entry.toolCalls = toolCalls;
      try { entry.fileSizeKB = Math.floor(statSync(c.path).size / 1024); } catch { entry.fileSizeKB = 0; }
      entry.isSubagent = c.tier !== "session";
      entry.tier = c.tier;                 // NEW: which of the three, not just yes/no
      entry.workflowRunId = c.run;         // NEW: groups a fan-out back together
    }
    sessions.push(entry);
  }

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
