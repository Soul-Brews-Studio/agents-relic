import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";

/**
 * The only store. LanceDB holds events, sessions and the manifest; there is no
 * second index to keep in step.
 *
 * Why no SQLite FTS5 alongside: LanceDB's own full-text index with the ICU tokenizer
 * answers everything FTS5 was carried for, in 1-4 ms, from the same table. One store,
 * one index, no query routing, and no second thing to drift. Vectors land here too.
 *
 * Measured on the largest real shard (91,484 events) — see ensureFtsIndex
 * for the full table. Headline: ICU 1-4 ms, ngram(3) 2-36 ms and MISSES 2-char
 * queries entirely, raw LIKE scan 27-41 ms.
 *
 * Lessons pinned from lance-indexer, each of which cost someone a debugging session:
 *   - pin apache-arrow@18.1.0 — version drift produces cryptic Arrow errors
 *   - PLAIN JS OBJECTS ONLY into createTable/mergeInsert — class instances mangle
 *   - assert countRows after create — a table can be created and hold nothing
 *   - no nulls in typed columns; use "" / 0 so the schema infers cleanly
 */

export interface EventRow {
  uid: string;            // sha1(source, basename, seq) — path-independent, dedups across roots
  session_uuid: string;
  file_path: string;
  repo_key: string;
  seq: number;            // Nth NON-EMPTY line — the jump-to key back into the file
  role: string;
  ts: string;             // "" when absent
  text: string;
  source: string;         // claude | codex
  tier: string;           // session | subagent | workflow_agent
  worktree: string;       // which worktree/agent/lab the session ran in — "" = main checkout
  cwd: string;            // full working dir, so a path substring is searchable too
}

export interface SessionRow {
  session_uuid: string; file_path: string; repo_key: string; project_dir: string;
  tier: string; source: string; cwd: string; model: string; worktree: string;
  workflow_run_id: string; agent_id: string;
  file_mtime: number; file_size: number;
  line_count: number; event_count: number; bad_lines: number;
  started_at: string; ended_at: string; description: string; imported_at: string;
}

/** (path, mtime, size) is the import-diff identity — no content hashing. */
export interface FileRow {
  file_path: string; repo_key: string; mtime: number; size: number; imported_at: string;
}

export interface Hit extends EventRow { }

/** Lance filters are SQL strings. Quote by doubling; never concatenate raw input. */
export function sqlStr(s: string): string { return `'${s.replace(/'/g, "''")}'`; }

export class LanceStore {
  private constructor(private db: lancedb.Connection, private cache = new Map<string, lancedb.Table>()) {}

  static async open(dir: string): Promise<LanceStore> {
    mkdirSync(dir, { recursive: true });
    return new LanceStore(await lancedb.connect(dir));
  }

  private async existing(name: string): Promise<lancedb.Table | null> {
    const c = this.cache.get(name);
    if (c) return c;
    if (!(await this.db.tableNames()).includes(name)) return null;
    const t = await this.db.openTable(name);
    this.cache.set(name, t);
    return t;
  }

  /** Upsert on a natural key. Creates the table from the first batch if absent. */
  private async upsert(name: string, key: string, rows: Record<string, unknown>[]): Promise<void> {
    if (!rows.length) return;
    let t = await this.existing(name);
    if (!t) {
      t = await this.db.createTable(name, rows);
      if ((await t.countRows()) === 0) throw new Error(`lance: created ${name} but it holds 0 rows`);
      this.cache.set(name, t);
      return;                                     // the create WAS the insert
    }
    await t.mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  putEvents  = (rows: EventRow[])  => this.upsert("events",   "uid",       rows as unknown as Record<string, unknown>[]);
  putSession = (row: SessionRow)   => this.upsert("sessions", "file_path", [row as unknown as Record<string, unknown>]);
  putFile    = (row: FileRow)      => this.upsert("files",    "file_path", [row as unknown as Record<string, unknown>]);

  /** A shrinking file must not leave orphaned events behind. */
  async deleteEventsOf(filePath: string): Promise<void> {
    const t = await this.existing("events");
    await t?.delete(`file_path = ${sqlStr(filePath)}`);
  }

  /** The manifest, as a map — small enough to hold in memory per shard. */
  async manifest(): Promise<Map<string, { mtime: number; size: number }>> {
    const out = new Map<string, { mtime: number; size: number }>();
    const t = await this.existing("files");
    if (!t) return out;
    for (const r of await t.query().select(["file_path", "mtime", "size"]).toArray() as any[])
      out.set(String(r.file_path), { mtime: Number(r.mtime), size: Number(r.size) });
    return out;
  }

  /**
   * Build the full-text index. ICU tokenizer, chosen by measurement on a real
   * 91,484-event shard:
   *
   *   query                     ngram(3)      icu        LIKE scan
   *   freelist                   36 ms       4 ms         41 ms
   *   ความ                        2 ms       2 ms         30 ms
   *   structured_output_mode     35 ms       1 ms         28 ms
   *   ok                       0 HITS        1 ms         27 ms
   *
   * ICU does real Thai word segmentation rather than blind n-grams, so Thai matches
   * without a second index — and unlike ngram(3) it still answers a 2-character query,
   * which is the cliff that forced FTS5 to carry two tokenizers and a routing rule.
   * Build cost is 1.4 s for 91k rows, so it is cheap to rebuild after an import.
   *
   * (The "tantivy is 10-200x slower than FTS5" note in lance-indexer predates this
   * engine. Re-measured here, FTS is 7-28x FASTER than the LIKE scan it replaced.)
   */
  async ensureFtsIndex(): Promise<void> {
    const t = await this.existing("events");
    if (!t) return;
    const has = (await t.listIndices()).some(i => i.columns.includes("text"));
    if (has) return;
    await t.createIndex("text", {
      config: Index.fts({
        baseTokenizer: "icu",

        // stem:false — this is a CODE corpus, and the English stemmer mangles identifiers.
        // Proven with table.tokenize():
        //   stem:true    structured_output_mode -> structured_output_mod
        //                CLAUDE_..._AGENT_TEAMS -> claude_..._agent_team
        //   stem:false   both exact
        // The cost is that `sessions` no longer matches `session`. That is the right
        // trade here: a 3,000-event sample held 354 distinct identifiers over 21 chars
        // (env vars, git SHAs, index names), and searching for a precise identifier is
        // the common case — searching for an English plural is not.
        stem: false,

        // Long identifiers and 64-char hashes must survive whole.
        maxTokenLength: 128,
      }),
    });
  }

  /** Full-text search, BM25-ranked. Falls back to a LIKE scan if no index exists yet. */
  async search(q: string, opts: { limit?: number; tier?: string; source?: string; worktree?: string; path?: string; since?: string; until?: string; role?: string; prose?: boolean } = {}): Promise<Hit[]> {
    const t = await this.existing("events");
    if (!t) return [];
    const limit = opts.limit ?? 20;
    const filters: string[] = [];
    if (opts.tier)   filters.push(`tier = ${sqlStr(opts.tier)}`);
    if (opts.source) filters.push(`source = ${sqlStr(opts.source)}`);
    // worktree is context, not noise: "which worktree was this said in" is usually
    // the same question as "what was I working on".
    if (opts.worktree) filters.push(`worktree LIKE '%${opts.worktree.replace(/'/g, "''")}%'`);
    if (opts.path)     filters.push(`cwd LIKE '%${opts.path.replace(/'/g, "''")}%'`);
    // ts is ISO-8601 with a Z suffix, so lexicographic comparison IS chronological —
    // no parsing, and it pushes down into the scan. Verified on a 20k-row sample that
    // every indexed event carries a ts: relic only indexes user/assistant/system
    // records, not the UI/state types where the field is often absent.
    // Role filtering is the highest-value filter this index has: 80% of a session
    // transcript is tool traffic, so unfiltered ranking buries human and assistant
    // prose under command output — including this tool's own output.
    if (opts.role)  filters.push(`role = ${sqlStr(opts.role)}`);
    if (opts.prose) filters.push(`(role = 'user' OR role = 'assistant')`);
    if (opts.since)    filters.push(`ts >= ${sqlStr(opts.since)}`);
    if (opts.until)    filters.push(`ts <= ${sqlStr(opts.until)}`);

    try {
      let s = t.search(q, "fts").limit(limit);
      if (filters.length) s = s.where(filters.join(" AND "));
      return await s.toArray() as unknown as Hit[];
    } catch {
      const where = [`text LIKE '%${q.replace(/'/g, "''")}%'`, ...filters];
      return await t.query().where(where.join(" AND ")).limit(limit).toArray() as unknown as Hit[];
    }
  }

  /**
   * List sessions, newest first. Filtered on started_at, which is the session's own
   * first timestamp — NOT file mtime, which moves every time a transcript is appended
   * to and would make an old session look new.
   */
  async sessions(opts: { since?: string; until?: string; worktree?: string; limit?: number } = {}): Promise<SessionRow[]> {
    const t = await this.existing("sessions");
    if (!t) return [];
    const where: string[] = [];
    if (opts.since)    where.push(`started_at >= ${sqlStr(opts.since)}`);
    if (opts.until)    where.push(`started_at <= ${sqlStr(opts.until)}`);
    if (opts.worktree) where.push(`worktree LIKE '%${opts.worktree.replace(/'/g, "''")}%'`);
    let q = t.query();
    if (where.length) q = q.where(where.join(" AND "));
    const rows = await q.toArray() as unknown as SessionRow[];
    rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async counts(): Promise<{ events: number; sessions: number; files: number }> {
    const names = await this.db.tableNames();
    const n = async (x: string) => names.includes(x) ? await (await this.db.openTable(x)).countRows() : 0;
    return { events: await n("events"), sessions: await n("sessions"), files: await n("files") };
  }

  async sessionStats(): Promise<{ tier: string; source: string; events: number }[]> {
    const t = await this.existing("sessions");
    if (!t) return [];
    const rows = await t.query().select(["tier", "source", "event_count"]).toArray() as any[];
    const agg = new Map<string, { tier: string; source: string; events: number }>();
    for (const r of rows) {
      const k = `${r.source}/${r.tier}`;
      const cur = agg.get(k) ?? { tier: String(r.tier), source: String(r.source), events: 0 };
      cur.events += Number(r.event_count ?? 0);
      agg.set(k, cur);
    }
    return [...agg.values()];
  }
}
