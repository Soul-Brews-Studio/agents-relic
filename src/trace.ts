import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultRoot } from "./repo.js";

/**
 * A query trace log — one JSONL line per search.
 *
 * Why JSONL and not a table: this tool indexes JSONL for a living, so the trace log is
 * readable by the thing it describes. No schema migration, no second reader, and
 * `relic` can index its own history if that ever becomes interesting.
 *
 * Why it exists at all: every claim about which index deserves to survive has so far
 * been an argument. A store that never answers a query nobody opens has no
 * constituency, and that is a measurement, not an opinion. The log is the evidence.
 *
 * It records the query and the shape of the answer — never the matched text, so the
 * log never becomes a second copy of the corpus.
 */

export interface TraceEntry {
  ts: string;
  q: string;
  chars: number;          // query length — trigram/短 queries behave differently
  filters: Record<string, string>;
  shards: number;         // how many were opened
  hits: number;
  ms: number;
  top_repo: string;       // which shard produced the best hit, "" if none
  fts: boolean;           // true = index answered, false = LIKE fallback
  opened?: string;        // set later by `relic show`, when a hit is actually read
}

export function tracePath(dataRoot: string | null): string {
  return join(dataRoot ?? defaultRoot(), "trace.jsonl");
}

/** Append one line. Never throws — a broken log must not break a search. */
export function trace(entry: TraceEntry, dataRoot: string | null): void {
  if (process.env.RELIC_NO_TRACE) return;
  try {
    const p = tracePath(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    // Single write() of one line: the fleet has two separate incidents of a JSONL log
    // corrupting under concurrent append when built up from multiple writes.
    appendFileSync(p, JSON.stringify(entry) + "\n");
  } catch { /* tracing is never worth failing a query for */ }
}

export interface TraceStats {
  total: number;
  opened: number;
  openedByRepo: { repo: string; n: number }[];
  span: string;
  byRepo: { repo: string; n: number }[];
  byFilter: { filter: string; n: number }[];
  zeroHit: number;
  ftsMisses: number;
  slowest: { q: string; ms: number }[];
  medianMs: number;
  neverTop: string[];     // shards that exist but never produced a best hit
  terms: { term: string; n: number }[];   // query keywords, most-asked first
}

/**
 * Query keywords. Both the whole query AND its whitespace tokens are counted: a Thai
 * query has no spaces to split on, so token-only counting would lose it entirely, and
 * a multi-word query is itself a thing someone asked for.
 *
 * Single-use terms are kept here and filtered at render — the fleet's tag cloud learned
 * that a cloud made of 1:1 entries is all size-1 noise, but the raw count is still
 * useful for "how many distinct things have I ever looked for".
 */
function terms(q: string): string[] {
  const t = q.trim();
  if (!t) return [];
  const parts = t.split(/\s+/).filter(w => w.length > 1);
  return parts.length > 1 ? [t, ...parts] : [t];
}

export function readTrace(dataRoot: string | null, knownShards: string[] = []): TraceStats | null {
  const p = tracePath(dataRoot);
  if (!existsSync(p)) return null;

  const entries: TraceEntry[] = [];
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* skip a torn line */ }
  }
  if (!entries.length) return null;

  // `opened` rows are reads, not queries — count them separately or every median,
  // zero-hit ratio and latency figure is diluted by rows that never ran a search.
  const opens = entries.filter(e => e.opened);
  const queries = entries.filter(e => !e.opened);
  if (!queries.length) return null;

  const tally = (xs: string[]) => {
    const m = new Map<string, number>();
    for (const x of xs) if (x) m.set(x, (m.get(x) ?? 0) + 1);
    return [...m].sort((a, b) => b[1] - a[1]);
  };

  const times = queries.map(e => e.ms).sort((a, b) => a - b);
  const topRepos = tally(queries.map(e => e.top_repo));
  const seenTop = new Set(topRepos.map(([r]) => r));

  return {
    total: queries.length,
    opened: opens.length,
    openedByRepo: tally(opens.map(e => e.top_repo)).map(([repo, n]) => ({ repo, n })),
    span: `${entries[0].ts.slice(0, 16)} → ${entries[entries.length - 1].ts.slice(0, 16)}`,
    byRepo: topRepos.map(([repo, n]) => ({ repo, n })),
    byFilter: tally(queries.flatMap(e => Object.keys(e.filters ?? {}))).map(([filter, n]) => ({ filter, n })),
    zeroHit: queries.filter(e => e.hits === 0).length,
    ftsMisses: queries.filter(e => e.fts === false).length,
    slowest: [...queries].sort((a, b) => b.ms - a.ms).slice(0, 5).map(e => ({ q: e.q, ms: e.ms })),
    medianMs: times[Math.floor(times.length / 2)] ?? 0,
    // The point of the whole log: shards with no constituency.
    neverTop: knownShards.filter(s => !seenTop.has(s)),
    terms: tally(queries.flatMap(e => terms(e.q))).map(([term, n]) => ({ term, n })),
  };
}
