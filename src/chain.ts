import type { SessionRow } from "./store/lance.js";
import { localTime, localDate, zoneOffset } from "./time.js";

/**
 * A session and everything it spawned, on one time axis.
 *
 * The question this answers is "what was actually happening at once" — which a list
 * sorted by start time cannot show. Agents in a workflow run start within the same
 * second and finish minutes apart, so the interesting structure is OVERLAP, and
 * overlap is only visible when every row shares an axis.
 *
 * Three tiers, three meanings:
 *   session         the parent transcript — the human's conversation
 *   subagent        one agent spawned directly from it
 *   workflow_agent  an agent inside a workflow run; these are the parallel ones
 */

export interface ChainRow extends SessionRow { repo: string }

export interface ChainGroup {
  run: string;                 // workflow run id, "subagents", or "session"
  rows: ChainRow[];
  startMs: number;
  endMs: number;
  peak: number;                // max simultaneously running
}

export interface Chain {
  id: string;
  total: number;
  startMs: number;
  endMs: number;
  groups: ChainGroup[];
  wallMs: number;              // span from first start to last end
  workMs: number;              // summed durations — exceeds wall when work overlapped
}

const ms = (s: string) => { const t = Date.parse(s); return Number.isNaN(t) ? 0 : t; };

/** Max number of rows running at the same instant — the real parallelism. */
function peakConcurrency(rows: ChainRow[]): number {
  const edges: [number, number][] = [];
  for (const r of rows) {
    const a = ms(r.started_at), b = ms(r.ended_at);
    if (!a) continue;
    edges.push([a, 1], [Math.max(b, a), -1]);
  }
  edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let cur = 0, peak = 0;
  for (const [, d] of edges) { cur += d; peak = Math.max(peak, cur); }
  return peak;
}

export function buildChain(id: string, all: ChainRow[]): Chain {
  // A workflow directory also holds journal.jsonl — bookkeeping with no events and no
  // clock. Left in, it renders as a zero-length bar at the axis origin in every group.
  const rows = all.filter(r => Number(r.event_count) > 0 && r.started_at);

  const groups = new Map<string, ChainRow[]>();
  for (const r of rows) {
    // A workflow run is a unit of intent: one fan-out, N agents. Subagents spawned
    // directly are their own bucket, and the parent session stands alone.
    const key = r.workflow_run_id ? r.workflow_run_id
              : r.tier === "session" ? "session"
              : "subagents";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }

  const out: ChainGroup[] = [];
  for (const [run, gr] of groups) {
    gr.sort((a, b) => ms(a.started_at) - ms(b.started_at));
    const starts = gr.map(r => ms(r.started_at)).filter(Boolean);
    const ends = gr.map(r => Math.max(ms(r.ended_at), ms(r.started_at))).filter(Boolean);
    out.push({
      run, rows: gr,
      startMs: Math.min(...starts), endMs: Math.max(...ends),
      peak: peakConcurrency(gr),
    });
  }
  out.sort((a, b) => a.startMs - b.startMs);

  const allStarts = rows.map(r => ms(r.started_at)).filter(Boolean);
  const allEnds = rows.map(r => Math.max(ms(r.ended_at), ms(r.started_at))).filter(Boolean);
  const startMs = Math.min(...allStarts), endMs = Math.max(...allEnds);
  const workMs = rows.reduce((a, r) => {
    const s = ms(r.started_at), e = Math.max(ms(r.ended_at), s);
    return a + (s ? e - s : 0);
  }, 0);

  return { id, total: rows.length, startMs, endMs, groups: out, wallMs: endMs - startMs, workMs };
}

// Local, not UTC. The axis of `chain` and the axis of `now` describe the same clock;
// when one was ISO-sliced and the other toTimeString'd they disagreed by the offset.
const hhmm = (t: number) => localTime(t);
const dayOf = (t: number) => localDate(t);

function dur(msv: number): string {
  const s = Math.round(msv / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m}m` : `${(m / 60).toFixed(1)}h`;
}

/** Render one bar on a shared axis of `width` cells. */
function bar(startMs: number, endMs: number, t0: number, t1: number, width: number): string {
  const span = Math.max(1, t1 - t0);
  let a = Math.round(((startMs - t0) / span) * (width - 1));
  let b = Math.round(((endMs - t0) / span) * (width - 1));
  a = Math.max(0, Math.min(width - 1, a));
  b = Math.max(a, Math.min(width - 1, b));
  const body = b > a ? "▬".repeat(b - a + 1) : "▪";
  return " ".repeat(a) + body + " ".repeat(Math.max(0, width - a - body.length));
}

export function renderChain(c: Chain, opts: { width?: number; maxRows?: number } = {}): string {
  const W = opts.width ?? 40;
  const maxRows = opts.maxRows ?? 8;
  const L: string[] = [];
  const multiDay = dayOf(c.startMs) !== dayOf(c.endMs);

  L.push(`${c.id} · ${c.total} transcripts · ${dayOf(c.startMs)} ${hhmm(c.startMs)} → ` +
         `${multiDay ? dayOf(c.endMs) + " " : ""}${hhmm(c.endMs)}  (UTC${zoneOffset()})`);
  // work > wall is the whole point: it only happens when things ran at the same time.
  L.push(`wall ${dur(c.wallMs)} · agent-time ${dur(c.workMs)} · ` +
         `${(c.workMs / Math.max(1, c.wallMs)).toFixed(1)}x parallel`);
  L.push("");

  for (const g of c.groups) {
    const label = g.run === "session" ? "PARENT SESSION"
                : g.run === "subagents" ? "subagents (direct)"
                : g.run;
    L.push(`${label}   ${g.rows.length} transcript${g.rows.length === 1 ? "" : "s"} · ` +
           `${hhmm(g.startMs)}–${hhmm(g.endMs)} · ${dur(g.endMs - g.startMs)} · peak ${g.peak} at once`);

    // Each group gets its OWN axis. On a shared one, a 47-hour parent session squashes
    // every 2-minute workflow into a single cell and the parallelism — the thing worth
    // seeing — disappears.
    for (const r of g.rows.slice(0, maxRows)) {
      const s = Date.parse(r.started_at) || g.startMs;
      const e = Math.max(Date.parse(r.ended_at) || s, s);
      const name = (r.agent_id || r.tier).slice(0, 22).padEnd(22);
      L.push(`  ${hhmm(s)} ${name} |${bar(s, e, g.startMs, g.endMs, W)}| ${dur(e - s).padStart(5)} ${String(r.event_count).padStart(5)}ev`);
    }
    if (g.rows.length > maxRows) L.push(`  … and ${g.rows.length - maxRows} more`);
    L.push(`  ${" ".repeat(29)}${hhmm(g.startMs)}${"─".repeat(Math.max(0, W - 10))}${hhmm(g.endMs)}`);
    L.push("");
  }

  L.push("each group is scaled to its own span — bars compare WITHIN a run, not across");
  return L.join("\n");
}
