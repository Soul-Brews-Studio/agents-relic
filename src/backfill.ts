import { statSync } from "node:fs";
import { LanceStore } from "./store/lance.js";
import { loadSources, parserFor } from "./sources.js";
import { parseChannelEnvelope, type ChannelFacets } from "./types.js";
import { parseClaude } from "./shapes/claude.js";
import { pickShards, nameOf, type Scope } from "./query.js";
import { roomsOf } from "./import.js";

/**
 * `relic index --backfill-channel` — give rows indexed before channel facets existed the
 * facets they would have been written with, IN PLACE.
 *
 * widen() gives an old shard the facet columns with "" in every row, and a row keeps that
 * "" until its file changes, which for a finished session is never. Everything needed to
 * fill it is already in the index: the stored text keeps the envelope byte for byte, and
 * the noise filter never drops a user row. So the facets are computed FROM THE INDEX and
 * written back by uid — no transcript is read, no row is deleted, re-filtered or moved.
 *
 * The first version re-imported each file instead, and that was wrong three ways, all
 * measured on m5: a run killed between the delete commit and the insert commit lost the
 * file's events for good (the manifest still matched, so `index` never re-read it); it
 * re-applied today's noise filter and removed 100,909 of the 751,033 rows those files held;
 * and it moved rows between same-named copies that share uids by design.
 *
 * What is written, per shard, each in one commit:
 *   facets  the six event columns, on user rows that open with an envelope
 *   rooms   the session row's via / chat_id / from_users lists, from those same rows
 *   names   (--names only) the session description, re-read from the transcript's first
 *           turn — the one fact the index cannot rebuild when the row was cut at 200 chars
 */

/** The six columns a channel turn's row carries — ChannelFacets without the body. */
const FACET_COLS = ["via", "chat_id", "msg_id", "from_user", "from_user_id", "sent_ts"] as const;
const facetsOf = (c: ChannelFacets) =>
  ({ via: c.via, chat_id: c.chat_id, msg_id: c.msg_id, from_user: c.from_user, from_user_id: c.from_user_id, sent_ts: c.sent_ts });

export interface ShardBackfill {
  dir: string; key: string;
  events: Record<string, unknown>[];     // whole rows, facets set — written back by uid
  sessions: Record<string, unknown>[];   // whole rows, rooms (and with --names, description) set
  files: number;                         // transcripts whose rows change
}

export interface BackfillPlan {
  shards: ShardBackfill[];
  scanned: number;                       // shards read
  turns: number;                         // channel turns that get facets
  rooms: number;                         // session rows that get room lists
  names: {
    pending: number;      // session rows still named by an envelope tag, on a Claude transcript still on disk
    untitled: number;     // of those, named "(untitled)" — the words were past the 200-char cut
    bytes: number;        // what --names would read to rebuild them
    planned: number;      // re-read and planned this run (--names only)
    gone: number;         // the transcript is no longer on disk, or would not parse
    otherShape: number;   // not a Claude transcript — only that shape strips the tag
  };
  ms: number;
}

const same = (a: unknown, b: unknown) => String(a ?? "") === String(b ?? "");

/**
 * What the backfill would write, computed from the index. Read-only — the dry run prints
 * this, and --apply writes exactly this plan, so the number approved is the number written.
 *
 * `names` re-reads transcripts, so it is planned only when asked for; without it the dry
 * run still counts the rows it would touch, reading nothing but the index.
 */
export async function planChannelBackfill(
    s: Scope, o: { names?: boolean; onShard?: (done: number, total: number, key: string) => void } = {},
): Promise<BackfillPlan> {
  const t0 = Date.now();
  const sources = loadSources();
  const plan: BackfillPlan = { shards: [], scanned: 0, turns: 0, rooms: 0,
                               names: { pending: 0, untitled: 0, bytes: 0, planned: 0, gone: 0, otherShape: 0 }, ms: 0 };

  const shards = pickShards(s);
  for (const [i, sh] of shards.entries()) {
    o.onShard?.(i + 1, shards.length, sh.key);
    let store: LanceStore, rows: Record<string, unknown>[], named: Record<string, unknown>[];
    try {
      store = await LanceStore.open(sh.dir);
      rows = await store.channelRows();
      named = await store.namedByEnvelope();
    } catch { continue; }            // a shard mid-write can throw; the rest still answer
    plan.scanned++;
    if (!rows.length && !named.length) continue;

    // Facets: every row that PARSES as a delivery, whose stored facets are not already
    // what its text says. Quoted envelopes do not parse and are never touched.
    const events: Record<string, unknown>[] = [];
    const byFile = new Map<string, { channel: ChannelFacets }[]>();
    for (const r of rows) {
      const c = parseChannelEnvelope(String(r.text ?? ""));
      if (!c) continue;
      const fp = String(r.file_path);
      (byFile.get(fp) ?? byFile.set(fp, []).get(fp)!).push({ channel: c });
      const f = facetsOf(c);
      if (FACET_COLS.some(k => !same(r[k], f[k]))) events.push({ ...r, ...f });
    }

    // Rooms: from ALL of a file's deliveries, faceted already or not — so a run killed
    // after the event commit and before the session commit finishes the rooms next time.
    const sessions = new Map<string, Record<string, unknown>>();
    for (const r of await store.sessionsOf([...byFile.keys()]) as unknown as Record<string, unknown>[]) {
      const rooms = roomsOf(byFile.get(String(r.file_path)) ?? []);
      if (!same(r.via, rooms.via) || !same(r.chat_id, rooms.chat_id) || !same(r.from_users, rooms.from_users))
        sessions.set(String(r.file_path), { ...r, ...rooms });
    }
    const roomRows = sessions.size;

    // Names: counted and sized always, from a stat; the transcript is read only with --names.
    for (const r of named) {
      const path = String(r.file_path);
      let size = 0;
      try { size = statSync(path).size; } catch { plan.names.gone++; continue; }
      const parser = sources.find(x => x.key === r.source)?.parser ?? parserFor(path);
      // Only the Claude shape strips an envelope from the description (#92).
      if (parser !== parseClaude) { plan.names.otherShape++; continue; }
      plan.names.pending++;
      plan.names.bytes += size;
      if (nameOf(r as { title?: unknown; description?: unknown }) === "(untitled)") plan.names.untitled++;
      if (!o.names) continue;
      let p;
      try { p = await parseClaude(path); } catch { plan.names.gone++; continue; }
      // The file's own read also knows its rooms — exact even for a copy whose rows a
      // same-named twin owns in this shard, which the index cannot see.
      sessions.set(path, { ...(sessions.get(path) ?? r), description: p.description ?? "", ...roomsOf(p.events) });
      plan.names.planned++;
    }

    if (!events.length && !sessions.size) continue;
    const files = new Set([...events.map(e => String(e.file_path)), ...sessions.keys()]);
    plan.shards.push({ dir: sh.dir, key: sh.key, events, sessions: [...sessions.values()], files: files.size });
    plan.turns += events.length;
    plan.rooms += roomRows;
  }
  plan.ms = Date.now() - t0;
  return plan;
}

/**
 * Write the plan, one shard at a time: its event rows in one commit, then its session
 * rows in another. Nothing is deleted and nothing is inserted, so a kill at any point
 * leaves rows either as they were or as they should be; the next plan is what is left.
 */
export async function applyChannelBackfill(plan: BackfillPlan,
    onShard?: (done: number, total: number, key: string) => void): Promise<{ events: number; sessions: number }> {
  const out = { events: 0, sessions: 0 };
  for (let i = 0; i < plan.shards.length; i++) {
    const sh = plan.shards[i];
    const store = await LanceStore.open(sh.dir);
    await store.updateRows("events", "uid", sh.events);
    out.events += sh.events.length;
    await store.updateRows("sessions", "file_path", sh.sessions);
    out.sessions += sh.sessions.length;
    onShard?.(i + 1, plan.shards.length, sh.key);
  }
  return out;
}
