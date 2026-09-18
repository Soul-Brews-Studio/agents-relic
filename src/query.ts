import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { parseSince } from "./discover.js";
import { listShards } from "./repo.js";
import { seekOnDisk } from "./seek.js";
import { importFiles } from "./import.js";
import { buildChain, type Chain, type ChainRow } from "./chain.js";

/**
 * Reading from the index — every lookup relic can do, as functions that return DATA.
 *
 * Both front ends call this: the CLI renders the result for a human, the MCP server
 * serialises it for a model. Neither reimplements a query. When the same lookup exists
 * twice it drifts, and the version the model gets is the one nobody runs by hand.
 *
 * Nothing here prints or exits. A caller decides what a miss looks like.
 */

export interface Scope {
  dataRoot?: string | null;
  inRepo?: boolean;
  repo?: string;        // substring of the shard key, e.g. "neo-oracle"
}

export interface SearchOpts extends Scope {
  limit?: number;
  tier?: string; source?: string; worktree?: string; path?: string; role?: string;
  since?: string; until?: string;   // 7d / 12h / 30m / 2026-09-01 / full ISO
  prose?: boolean;
}

/**
 * Normalise a date flag to an ISO string the stored `ts` can be compared against.
 *
 * Accepts a relative span (`7d`, `12h`, `30m`), a bare date (`2026-09-01`), or an ISO
 * timestamp passed straight through. `endOfDay` makes a bare date an inclusive upper
 * bound — `--until 2026-09-01` meaning "through the 1st", not "up to its first second".
 */
export function toISO(v: unknown, endOfDay = false): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const raw = String(v);
  const rel = parseSince(raw);
  if (rel && /^\d+[mhd]$/.test(raw)) return new Date(rel).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + (endOfDay ? "T23:59:59Z" : "T00:00:00Z");
  return raw;
}

/** The shards a query will touch, after the `--repo` substring filter. */
export function pickShards(s: Scope) {
  const all = listShards(s.dataRoot ?? null, Boolean(s.inRepo));
  return s.repo ? all.filter(x => x.key.includes(s.repo!)) : all;
}

export interface SearchResult {
  hits: (EventRow & { repo: string })[];
  shards: number;          // shards actually read
  available: number;       // shards that matched the scope
  ms: number;
  total: number;           // hits before the limit slice
}

export async function searchEvents(q: string, o: SearchOpts = {}): Promise<SearchResult> {
  const limit = o.limit ?? 20;
  const shards = pickShards(o);
  const hits: (EventRow & { repo: string })[] = [];
  let searched = 0;
  const t0 = performance.now();

  for (const s of shards) {
    try {
      const store = await LanceStore.open(s.dir);
      for (const h of await store.search(q, {
        limit, tier: o.tier, source: o.source, worktree: o.worktree, path: o.path,
        since: toISO(o.since), until: toISO(o.until, true), role: o.role, prose: o.prose,
      })) hits.push({ ...h, repo: s.key });
      searched++;
    } catch { /* a shard mid-write can throw; skip rather than abort the fan-out */ }
  }
  return { hits, shards: searched, available: shards.length,
           ms: Math.round(performance.now() - t0), total: hits.length };
}

export interface SessionsOpts extends Scope {
  limit?: number; since?: string; until?: string; worktree?: string;
}

export interface SessionsResult {
  rows: (SessionRow & { repo: string })[];   // already sliced to `limit`
  total: number;                             // before the slice
  events: number;                            // summed event_count over ALL matches
  shards: number;
}

export async function listSessions(o: SessionsOpts = {}): Promise<SessionsResult> {
  const shards = pickShards(o);
  const rows: (SessionRow & { repo: string })[] = [];
  let searched = 0;
  for (const sh of shards) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.sessions({
        since: toISO(o.since), until: toISO(o.until, true), worktree: o.worktree,
      })) rows.push({ ...r, repo: sh.key });
      searched++;
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const events = rows.reduce((a, r) => a + Number(r.event_count ?? 0), 0);
  return { rows: rows.slice(0, o.limit ?? 40), total: rows.length, events, shards: searched };
}

/** Every indexed transcript whose session_uuid starts with `id`. Index only. */
export async function findSessionById(id: string, s: Scope = {}): Promise<(SessionRow & { repo: string })[]> {
  const rows: (SessionRow & { repo: string })[] = [];
  for (const sh of pickShards(s)) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.findSession(id)) rows.push({ ...r, repo: sh.key });
    } catch { /* skip unreadable shard */ }
  }
  return rows;
}

export interface ResolveResult {
  rows: (SessionRow & { repo: string })[];
  imported: number;    // files pulled in on demand, 0 when the index already had it
}

/**
 * SEEK -> INDEX -> ANSWER.
 *
 * A session id maps to a filename, so a miss in the index is not an answer — it means
 * the file has not been imported yet. Locating it on disk is deterministic and importing
 * one file is fast, so do both rather than returning "run index first" and making the
 * caller improvise a `find`.
 */
export async function resolveSession(
  id: string, s: Scope & { noIndex?: boolean; skipNoise?: boolean } = {},
): Promise<ResolveResult> {
  let rows = await findSessionById(id, s);
  if (rows.length || s.noIndex) return { rows, imported: 0 };

  const found = seekOnDisk(id);
  if (!found.length) return { rows, imported: 0 };
  await importFiles(found, {
    dataRoot: s.dataRoot ?? null, inRepo: Boolean(s.inRepo), skipNoise: Boolean(s.skipNoise),
  });
  return { rows: await findSessionById(id, s), imported: found.length };
}

/** The session tree on one time axis. Resolves the id the same way `session` does. */
export async function chainOf(
  id: string, s: Scope & { noIndex?: boolean; skipNoise?: boolean } = {},
): Promise<{ chain: Chain | null; imported: number }> {
  const { rows, imported } = await resolveSession(id, s);
  return { chain: rows.length ? buildChain(id, rows as ChainRow[]) : null, imported };
}

export interface ContextLine { seq: number; role: string; text: string; target: boolean }

/**
 * Read the lines around one event, straight from the source `.jsonl`.
 *
 * The index stores a POINTER, not an archive — so this reads the file rather than the
 * shard, and stays correct for a transcript that has been appended to since indexing.
 */
export async function readAround(
  path: string, target: number, before = 2, after = 2,
): Promise<ContextLine[]> {
  const out: ContextLine[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf8") });
  let seq = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    seq++;
    if (seq < target - before) continue;
    if (seq > target + after) break;
    let role = "?", text: string = line.slice(0, 400);
    try {
      const rec = JSON.parse(line);
      role = rec.message?.role ?? rec.type ?? "?";
      const c = rec.message?.content ?? rec.payload?.content ?? rec.content;
      text = typeof c === "string" ? c : JSON.stringify(c ?? rec).slice(0, 600);
    } catch { /* a half-written last line is normal on a live transcript */ }
    out.push({ seq, role, text: String(text), target: seq === target });
  }
  rl.close();
  return out;
}

export interface ShardStat { key: string; events: number; sessions: number }

/**
 * Per-shard counts, biggest first.
 *
 * This doubles as repo DISCOVERY: the shard keys are exactly the values `repo` accepts
 * as a filter, so a caller that does not know what is indexed can find out here instead
 * of guessing a name.
 */
export async function indexStatus(s: Scope = {}): Promise<{ root: string; rows: ShardStat[] }> {
  const { defaultRoot } = await import("./repo.js");
  const rows: ShardStat[] = [];
  for (const sh of pickShards(s)) {
    try {
      const c = await (await LanceStore.open(sh.dir)).counts();
      rows.push({ key: sh.key, events: c.events, sessions: c.sessions });
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => b.events - a.events);
  return { root: s.dataRoot ?? defaultRoot(), rows };
}
