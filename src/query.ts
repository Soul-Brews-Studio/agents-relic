import { createReadStream, statSync } from "node:fs";
import os from "node:os";
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
  org?: string; project?: string; dir?: string; memType?: string;
  /**
   * Include subagent and workflow_agent transcripts. Default FALSE — see searchEvents.
   */
  allTiers?: boolean;
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

  /*
   * Query shards CONCURRENTLY.
   *
   * Each shard is an independent LanceDB directory, so the fan-out was 345 sequential
   * round-trips that shared nothing but the result array — measured at ~7 s unfiltered,
   * against ~330 ms for a single `--repo`. The work is IO-bound, so it overlaps well.
   *
   * Bounded, not unbounded: opening 345 LanceDB connections at once trades a latency
   * problem for a file-descriptor one. The cap tracks CPU count the same way the agent
   * runner does, with a floor so a small machine still overlaps.
   *
   * Measured on 345 shards, "peak concurrency", average of 3 runs each — single runs
   * vary by ~2 s here, so one-shot comparisons of this are worthless:
   *
   *   cap  1 (sequential)   9,211 ms
   *   cap 16 (default)      6,206 ms     <- 1.5x, not the 2.4x a single run suggested
   *   cap 32                6,762 ms
   *   cap 64                5,972 ms     <- no reliable gain above 16
   *
   * Concurrency softens the fan-out; it does not remove it, because the cost is 345
   * real FTS queries. Narrowing with `repo` is still worth an order of magnitude more
   * than any cap. RELIC_FANOUT overrides for measurement.
   */
  const CAP = Number(process.env.RELIC_FANOUT) > 0
    ? Number(process.env.RELIC_FANOUT)
    : Math.max(4, Math.min(16, (os.cpus?.().length ?? 8) - 2));
  /*
   * DEFAULT TO THE MAIN CONVERSATION.
   *
   * By file count the corpus is 73% workflow_agent (21,305 vs 7,327 session), and those
   * are an agent talking to itself inside one fan-out — near-duplicate prompts, tool
   * chatter, and the same instructions restated N times. The human's own thread is
   * where a decision was actually made.
   *
   * Measured before this default existed: unfiltered top-20 was already 60-75% session,
   * because BM25 favours the denser prose anyway. So this is not rescuing a drowned
   * signal — it is removing the remaining 25-40% of agent noise from the common case,
   * and cutting the work the fan-out does. `allTiers` gets it all back, and the CLI and
   * MCP both SAY SO on every result rather than silently narrowing.
   */
  /*
   * The default narrows to session AND note — not session alone.
   *
   * Vault notes are the OPPOSITE of the noise the tier default exists to cut: hand
   * written, one per idea, no near-duplicates. Excluding them would make `relic
   * search` silently miss the most deliberate writing in the corpus.
   *
   * `tier` must stay UNDEFINED when defaulting, or the store's `if (opts.tier)`
   * branch pins it to a single value and the multi-tier filter below is dead code.
   * That was the bug: default returned {session:30, note:0} while --all-tiers found
   * notes fine, so the vault indexed correctly and was invisible anyway.
   */
  const mainOnly = !o.tier && !o.allTiers;
  const tier = o.tier;
  const opts = { limit, tier, mainTiers: mainOnly, source: o.source, worktree: o.worktree, path: o.path,
                 org: o.org, project: o.project, dir: o.dir, memType: o.memType,
                 since: toISO(o.since), until: toISO(o.until, true), role: o.role, prose: o.prose };

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CAP, shards.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= shards.length) return;
      const s = shards[i];
      try {
        const store = await LanceStore.open(s.dir);
        for (const h of await store.search(q, opts)) hits.push({ ...h, repo: s.key });
        searched++;
      } catch { /* a shard mid-write can throw; skip rather than abort the fan-out */ }
    }
  }));
  /*
   * RANK ACROSS SHARDS BEFORE SLICING.
   *
   * Each shard returns its own top-`limit`; without this the caller sliced the
   * CONCATENATION in shard-iteration order, so the "top 20" was really "whatever the
   * first shards happened to hold". Measured on "peak concurrency" over 345 shards
   * and 1,493 hits: the displayed top-10 shared 1 result with the actual best 10, all
   * ten came from a single repo, and the best score shown was 14.46 against 19.84
   * available. LanceDB returned `_score` the whole time and it was discarded.
   *
   * Honest limit: BM25 is computed per index, so IDF reflects each shard's own corpus
   * and the scores are not strictly commensurable. They are close enough to be worth
   * far more than arrival order — same engine, same tokenizer, same schema — but this
   * is a ranking improvement, not a globally correct BM25.
   */
  hits.sort((a, b) => Number((b as any)._score ?? 0) - Number((a as any)._score ?? 0));

  /*
   * Drop events that exist in more than one transcript.
   *
   * Resuming a session forks a NEW transcript and copies the history forward, so the
   * same event lives in two files. relic's uid is (source, filename, seq) — deliberately
   * path-INdependent within a file but distinct across files — so a copied event is two
   * legitimate rows, and both surface. Measured unfiltered: 213 duplicate rows out of
   * 2,403 hits (8.9%) for one query, 85 of 1,235 for another.
   *
   * The key is (ts, role, text): a millisecond timestamp plus identical content is the
   * same event, not a coincidence. Sorting by score happens FIRST, so the copy that is
   * kept is the best-ranked one rather than whichever shard answered first.
   */
  const seen = new Set<string>();
  const deduped: typeof hits = [];
  for (const h of hits) {
    const k = `${h.ts}\u001f${h.role}\u001f${h.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    deduped.push(h);
  }
  hits.length = 0;
  hits.push(...deduped);

  return { hits, shards: searched, available: shards.length,
           ms: Math.round(performance.now() - t0), total: hits.length };
}

export interface SessionsOpts extends Scope {
  limit?: number; since?: string; until?: string; worktree?: string;
  /** false lists every transcript separately, children included. Default true. */
  group?: boolean;
}

/** A session row plus what its children add up to. */
export type SessionSummary = SessionRow & {
  repo: string;
  children: number;      // subagent + workflow_agent transcripts under it
  treeEvents: number;    // events across the whole tree, not just the parent
};

export interface SessionsResult {
  rows: SessionSummary[];                    // already sliced to `limit`
  total: number;                             // conversations, after grouping
  transcripts: number;                       // files behind them
  events: number;                            // summed over ALL matches
  shards: number;
}

/**
 * Fold a flat transcript list into one row per conversation.
 *
 * Without this, `sessions` counts FILES: one fan-out that spawned 110 workflow agents
 * reads as 111 sessions, all sharing a uuid, and the listing fills with agent prompts
 * instead of the human's. Measured on this index — 325 rows over 3 days collapse to 44
 * real conversations.
 *
 * The parent row represents the group. When a tree was indexed without its parent
 * (possible: children are separate files), the earliest child stands in, so a session
 * is never silently dropped.
 */
function groupTranscripts(rows: (SessionRow & { repo: string })[]): SessionSummary[] {
  const by = new Map<string, (SessionRow & { repo: string })[]>();
  for (const r of rows) {
    const k = r.session_uuid || r.file_path;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const out: SessionSummary[] = [];
  for (const group of by.values()) {
    group.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    const parent = group.find(r => r.tier === "session") ?? group[0];
    out.push({
      ...parent,
      children: group.length - 1,
      treeEvents: group.reduce((a, r) => a + Number(r.event_count ?? 0), 0),
    });
  }
  return out;
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
  const events = rows.reduce((a, r) => a + Number(r.event_count ?? 0), 0);
  const grouped = o.group === false
    ? rows.map(r => ({ ...r, children: 0, treeEvents: Number(r.event_count ?? 0) }))
    : groupTranscripts(rows);
  grouped.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return { rows: grouped.slice(0, o.limit ?? 40), total: grouped.length,
           transcripts: rows.length, events, shards: searched };
}

/**
 * Does this look like a session id, or like a name?
 *
 * A Claude/Codex session id is hex-and-dashes, so anything with a letter past `f`, a
 * space, or punctuation is a name. Getting this wrong is cheap in one direction only:
 * a name tried as an id returns nothing, so `resolveSession` tries the id first and
 * falls back — it never refuses to look.
 */
export function looksLikeId(s: string): boolean {
  return /^[0-9a-f]{4,}(-[0-9a-f]+)*$/i.test(s.trim());
}

/** Sessions matching a NAME — the host's title, or the opening message. Parents only. */
export async function findSessionByName(q: string, s: Scope = {}, limit = 40): Promise<(SessionRow & { repo: string })[]> {
  const rows: (SessionRow & { repo: string })[] = [];
  for (const sh of pickShards(s)) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.findSessionByName(q, limit)) rows.push({ ...r, repo: sh.key });
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return rows.slice(0, limit);
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
  matchedBy: "id" | "name" | "none";
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
  const rows = await findSessionById(id, s);
  if (rows.length) return { rows, imported: 0, matchedBy: "id" };

  // Only seek on disk for something that could BE a filename. A name has no file to
  // find, so seeking on it would walk every source directory to return nothing.
  if (!s.noIndex && looksLikeId(id)) {
    const found = seekOnDisk(id);
    if (found.length) {
      await importFiles(found, {
        dataRoot: s.dataRoot ?? null, inRepo: Boolean(s.inRepo), skipNoise: Boolean(s.skipNoise),
      });
      return { rows: await findSessionById(id, s), imported: found.length, matchedBy: "id" };
    }
  }

  // Fall back to the name. Ambiguity is the caller's to resolve: return every match
  // rather than picking one, because two sessions can share a title.
  const byName = await findSessionByName(id, s);
  if (!byName.length) return { rows: [], imported: 0, matchedBy: "none" };

  // A name matches the PARENT row only — titles belong to the conversation. Expand a
  // unique match back to its whole tree, so `session <name>` and `session <id>` answer
  // with the same thing. Without this the same session reports 1 transcript or 122
  // depending on how it was named, which is the kind of inconsistency that makes a
  // caller stop trusting the tool.
  const uuids = new Set(byName.map(r => r.session_uuid));
  if (uuids.size === 1) {
    const tree = await findSessionById(byName[0].session_uuid, s);
    if (tree.length) return { rows: tree, imported: 0, matchedBy: "name" };
  }
  return { rows: byName, imported: 0, matchedBy: "name" };
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
  // A Hermes "file" is <db>#<session_id> — there is nothing to open as a stream.
  // Without this, every Hermes search result printed a `show` pointer that crashed
  // with ENOENT, which makes a hit unopenable and the source effectively read-only.
  if (path.includes(".db#")) {
    const { parseHermes } = await import("./shapes/hermes.js");
    const p = await parseHermes(path);
    return p.events
      .filter(e => e.seq >= target - before && e.seq <= target + after)
      .map(e => ({ seq: e.seq, role: e.role, text: e.text, target: e.seq === target }));
  }

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

export interface SessionStats {
  transcripts: number; events: number;
  tiers: { tier: string; n: number }[];
  runs: number;                 // distinct workflow runs
  startedAt: string; endedAt: string;
  repo: string; worktree: string; model: string;
}

/** Roll a session's tree up into the few numbers worth printing above it. */
export function statsOf(rows: (SessionRow & { repo: string })[]): SessionStats | null {
  if (!rows.length) return null;
  const tiers = new Map<string, number>();
  const runs = new Set<string>();
  let events = 0, start = "", end = "";
  for (const r of rows) {
    tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
    if (r.workflow_run_id) runs.add(r.workflow_run_id);
    events += Number(r.event_count ?? 0);
    const s = String(r.started_at ?? ""), e = String(r.ended_at ?? "");
    if (s && (!start || s < start)) start = s;
    if (e && (!end || e > end)) end = e;
  }
  const parent = rows.find(r => r.tier === "session") ?? rows[0];
  return {
    transcripts: rows.length, events,
    tiers: [...tiers].map(([tier, n]) => ({ tier, n })).sort((a, b) => b.n - a.n),
    runs: runs.size, startedAt: start, endedAt: end,
    repo: parent.repo, worktree: parent.worktree ?? "", model: parent.model ?? "",
  };
}

export interface Neighbours {
  before: (SessionRow & { repo: string })[];
  after: (SessionRow & { repo: string })[];
}

/**
 * The sessions either side of this one, same repo, same worktree.
 *
 * A session rarely stands alone — it is one stretch of a longer thread of work, and
 * the question that follows "which session was that" is almost always "and what came
 * before it". Answering that from a session row alone means going back to the index
 * with a hand-built time filter, which is exactly the improvisation the tool exists to
 * remove. Scoped to the same worktree because that, not the repo, is the unit of work.
 */
export async function neighbours(
  row: SessionRow & { repo: string }, s: Scope = {}, before = 5, after = 5,
): Promise<Neighbours> {
  const iso = String(row.started_at ?? "");
  if (!iso) return { before: [], after: [] };
  const shard = pickShards({ ...s, repo: row.repo }).find(x => x.key === row.repo);
  if (!shard) return { before: [], after: [] };
  try {
    const store = await LanceStore.open(shard.dir);
    const n = await store.around(iso, { worktree: row.worktree || undefined, before, after });
    const tag = (r: SessionRow) => ({ ...r, repo: row.repo });
    return { before: n.before.map(tag), after: n.after.map(tag) };
  } catch { return { before: [], after: [] }; }
}

/**
 * Display name for a session: the host's own title, else its opening message.
 *
 * The fallback needs cleaning because an opening message is very often a slash command,
 * and Claude Code stores those wrapped in markup a human never typed —
 * `<command-message>dig</command-message><command-name>/dig</command-name>` and the
 * `<local-command-caveat>` preamble. Shown raw, the listing fills with tag soup and
 * every /dig session looks identical.
 */
export function nameOf(r: SessionRow): string {
  const t = String((r as any).title ?? "").trim();
  if (t) return t;

  let d = String(r.description ?? "");
  // A slash command: the command NAME is the useful part, so promote it.
  const cmd = d.match(/<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/)?.[1];
  const args = d.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  if (cmd) return (args ? `${cmd} ${args}` : cmd).replace(/\s+/g, " ").slice(0, 70);

  // description is truncated at 200 chars, so a caveat block often has no closing tag
  // to match against. Drop from the opening tag to the end rather than leaving the
  // boilerplate as the session's name.
  d = d.replace(/<local-command-caveat>[\s\S]*$/, "")
       .replace(/^\s*Caveat: The messages below were generated[\s\S]*$/, "")
       .replace(/<[^>]{1,40}>/g, " ")
       .replace(/\s+/g, " ").trim();
  return d ? d.slice(0, 70) : "(untitled)";
}


/**
 * How far the index has fallen behind the file it points at.
 *
 * relic stores a POINTER, not an archive, so a live session keeps growing after it was
 * imported — that is by design. It only becomes a trap when two commands are compared:
 * `dig` reads the file and `session` reads the index, so they report different end
 * times for the same session and the difference looks like a timezone bug. Measured
 * here: index ended 09:27Z, file had reached 10:28Z, exactly one hour of drift.
 *
 * Returns null when the file is gone or the index is current.
 */
export function staleness(row: SessionRow): { behindSec: number; fileMtimeMs: number } | null {
  try {
    const st = statSync(row.file_path);
    const behind = Math.round((st.mtimeMs - Number(row.file_mtime ?? 0) * 1000) / 1000);
    return behind > 60 ? { behindSec: behind, fileMtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}
