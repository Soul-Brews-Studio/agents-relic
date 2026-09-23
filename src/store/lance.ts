import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { mkdirSync } from "node:fs";
import { ensureFtsIndex as ensureFts, tokenizerOf, type FtsOutcome, type Tokenizer } from "./fts.js";

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
  uid: string;            // sha1(source, treeKeyOf(path), seq) — root-independent, dedups across roots
  session_uuid: string;
  file_path: string;
  repo_key: string;
  seq: number;            // Nth NON-EMPTY line — the jump-to key back into the file
  role: string;
  ts: string;             // "" when absent
  text: string;
  source: string;         // claude | codex
  /**
   * WHERE this sits in a transcript hierarchy. Nothing else.
   *
   * It used to also carry `note` and `memory`, which are not positions in a hierarchy
   * at all — they are different KINDS of thing. One column holding two axes is why the
   * default filter read as "main tiers" while actually meaning "one tier plus one
   * kind", and why a tier default of "session" once made 10,000 freshly-indexed vault
   * notes invisible while the result count looked healthy.
   */
  tier: string;           // session | subagent | workflow_agent
  /**
   * WHAT this is. The second axis, split out of `tier`.
   *
   * "" on rows written before this column existed — `widen()` backfills the default
   * rather than reindexing 509 shards, so every READ must fall back to `tier` until a
   * full rebuild lands. See kindOf() and the search filter.
   */
  kind: string;           // transcript | note | memory | message
  worktree: string;       // which worktree/agent/lab the session ran in — "" = main checkout
  cwd: string;            // full working dir, so a path substring is searchable too
  // The location hierarchy: org / repo / project / worktree / dir. repo_key fuses the
  // first two and drops the rest, which mis-attributes a nested vault to its host repo.
  org: string;
  project: string;        // nested oracle/lab/incubated repo, "" when not nested
  dir: string;            // directory below the worktree, e.g. "ψ/memory/learnings"
  // Claude Code memory only — "" for every other source. Kept as columns rather than
  // a separate table so search/show/sessions/MCP stay ONE query path; a mostly-empty
  // string column is cheap in a columnar store, a second table is a second code path
  // in all seven tools.
  mem_type: string;       // project | feedback | reference | user
  origin_session: string; // the session that produced this memory — the join key
}

export interface SessionRow {
  session_uuid: string; file_path: string; repo_key: string; project_dir: string;
  tier: string; source: string; cwd: string; model: string; worktree: string;
  workflow_run_id: string; agent_id: string;
  file_mtime: number; file_size: number;
  line_count: number; event_count: number; bad_lines: number;
  started_at: string; ended_at: string; description: string; imported_at: string;
  title: string;   // the host's own session name; "" when it wrote none
  git_branch: string;
}

/** (path, mtime, size) is the import-diff identity — no content hashing. */
export interface FileRow {
  file_path: string; repo_key: string; mtime: number; size: number; imported_at: string;
}

/**
 * One embedding. A SEPARATE TABLE, not a column on `events`.
 *
 * The obvious design is `embedding: number[]` on EventRow. It does not survive contact
 * with the 817 shards already on disk, and in THIS implementation it fails SILENTLY —
 * measured against @lancedb/lancedb 0.39.0, not feared:
 *
 *   widen() sees a missing column and calls addColumns({valueSql: "''"}) -> Utf8
 *   a later write of [0.1, 0.2, 0.3, 0.4]                               -> "0.1,0.2,0.3,0.4"
 *
 * No error at either step. Every vector computed afterwards lands as text, and the
 * vector index can never build. (The Python client raises ArrowNotImplementedError on
 * that same write — same Rust core, different client-side conversion — so the silent
 * half is ours alone. Both are pinned by tests.) widen() now refuses a non-scalar
 * column outright so that path is closed, but the deeper reason stands: a column forces a value for
 * EVERY row on the next write, and 3,394,951 events x 384 dims x 4 B is 4.86 GiB —
 * 1.5x the entire current index — to embed a corpus whose search already answers
 * better without it.
 *
 * A side table keyed on `uid` makes "index first, embed later" the natural shape: the
 * table starts absent, a backfill resumes by anti-joining uids, and embedding a
 * SUBSET needs no sentinel for "not embedded yet". The cost is one extra query —
 * vector search returns uids, then `events` is read by uid.
 */
export interface VectorRow {
  uid: string;            // the join key; events.uid is already its primary key
  embedding: number[];    // FixedSizeList<Float32, dim> — inferred from the first batch
  model: string;          // provider-qualified, e.g. "ollama:all-minilm"
  dim: number;
  norm: string;           // "l2" when written normalised, "" when raw — see embedShard()
  embedded_at: string;
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
    await this.widen(name, t, rows[0]);
    await t.mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
  }

  /**
   * Add columns a row has but the table does not.
   *
   * A schema addition would otherwise mean reindexing every shard — 345 of them here,
   * 3.2M events, hours — to gain one string. `addColumns` backfills existing rows with
   * the default instead, so an old shard keeps answering and fills the column in as its
   * sessions are re-imported. Cheap and idempotent: it only runs when a field is
   * genuinely absent, and a shard created after this change never triggers it.
   */
  private async widen(name: string, t: lancedb.Table, row: Record<string, unknown>): Promise<void> {
    const have = new Set((await t.schema()).fields.map(f => f.name));
    const missing = Object.keys(row).filter(k => !have.has(k));
    if (!missing.length) return;
    /*
     * REFUSE A NON-SCALAR. addColumns can only backfill a scalar `valueSql`, and the
     * failure mode is silence: a missing `embedding` column gets `''`, becomes Utf8,
     * and then accepts [0.1,0.2] by storing the string "0.1,0.2". Verified against
     * lancedb 0.39.0 — no error on the widen, no error on the write, and the column
     * reads back as a string forever. Better to stop here and make the caller create
     * a properly typed table than to let hours of embedding compute land as text.
     */
    for (const k of missing) {
      const v = row[k];
      if (typeof v === "string" || typeof v === "number") continue;
      const kind = Array.isArray(v) ? `array[${v.length}]` : typeof v;
      throw new Error(
        `lance: refusing to widen ${name} with non-scalar column "${k}" (${kind}). ` +
        `addColumns backfills a scalar default only, so this column would become Utf8 ` +
        `and silently store the value as text. Create a new table with the right schema.`);
    }
    await t.addColumns(missing.map(k => ({
      name: k,
      // The default must match the column's type or the backfill writes nulls that
      // later reads have to guard. Only string and numeric columns exist in this schema.
      valueSql: typeof row[k] === "number" ? "0" : "''",
    })));
    this.cache.delete(name);   // reopen so the cached handle sees the new schema
  }

  // ALL THREE take arrays. Every upsert is one versioned LanceDB commit, so a
  // single-row signature quietly forces one commit per row — which is invisible for
  // transcripts (one session row per file, thousands of events) and dominates for
  // document sources (one of EVERY row type per file).
  putEvents   = (rows: EventRow[])   => this.upsert("events",   "uid",       rows as unknown as Record<string, unknown>[]);
  putSessions = (rows: SessionRow[]) => this.upsert("sessions", "file_path", rows as unknown as Record<string, unknown>[]);
  putFiles    = (rows: FileRow[])    => this.upsert("files",    "file_path", rows as unknown as Record<string, unknown>[]);
  /**
   * Upsert embeddings. Re-embedding a uid REPLACES its vector, so a model switch is a
   * re-run, not a duplicate — but see embedShard(), which refuses to mix dims in one
   * table because a FixedSizeList has one width and mergeInsert would reject the batch
   * halfway through a long backfill.
   */
  putVectors  = (rows: VectorRow[])  => this.upsert("vectors",  "uid",       rows as unknown as Record<string, unknown>[]);

  /**
   * Drop the whole `vectors` table. The ONLY way to change model or dim on a shard —
   * a FixedSizeList has one width, so there is no in-place widening, and telling the
   * caller "drop it first" without giving them a way to do so is advice, not a tool.
   *
   * Scoped to `vectors` on purpose: it can never touch `events`, `sessions` or `files`,
   * so the worst case is re-running a backfill, never re-running an index.
   */
  async dropVectors(): Promise<boolean> {
    if (!(await this.db.tableNames()).includes("vectors")) return false;
    await this.db.dropTable("vectors");
    this.cache.delete("vectors");
    return true;
  }

  /** Single-row conveniences — prefer the array forms in any loop. */
  putSession = (row: SessionRow) => this.putSessions([row]);
  putFile    = (row: FileRow)    => this.putFiles([row]);

  /** A shrinking file must not leave orphaned events behind. */
  async deleteEventsOf(filePath: string): Promise<void> {
    const t = await this.existing("events");
    await t?.delete(`file_path = ${sqlStr(filePath)}`);
  }

  /** (uid, seq, file_path) of every event these files own — chunked like pruneFiles. */
  async eventKeysOf(paths: string[]): Promise<{ uid: string; seq: number; file_path: string }[]> {
    const t = await this.existing("events");
    if (!t || !paths.length) return [];
    const out: { uid: string; seq: number; file_path: string }[] = [];
    for (let i = 0; i < paths.length; i += 200) {
      const where = `file_path IN (${paths.slice(i, i + 200).map(sqlStr).join(", ")})`;
      for (const r of await t.query().where(where).select(["uid", "seq", "file_path"]).toArray() as any[])
        out.push({ uid: String(r.uid), seq: Number(r.seq), file_path: String(r.file_path) });
    }
    return out;
  }

  /** Vectors whose events are about to be re-keyed would otherwise be orphans nothing can reach. */
  async deleteVectors(uids: string[]): Promise<void> {
    const t = await this.existing("vectors");
    if (!t) return;
    for (let i = 0; i < uids.length; i += 200)
      await t.delete(`uid IN (${uids.slice(i, i + 200).map(sqlStr).join(", ")})`);
  }

  /**
   * Every file_path this shard holds a row for — the population `prune` compares
   * discovery against.
   *
   * Union of `files` and `sessions`, not either alone. A file that parses to ZERO
   * events still gets a session row and a file row, and journal.jsonl — the 1,353
   * stale rows that motivated prune — is exactly that shape. Reading only `events`
   * would report the index as already clean.
   */
  async indexedFiles(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const name of ["files", "sessions"]) {
      const t = await this.existing(name);
      if (!t) continue;
      for (const r of await t.query().select(["file_path"]).toArray() as any[])
        out.add(String(r.file_path));
    }
    return out;
  }

  /**
   * Remove every row belonging to these files — or count what removal would take.
   *
   * ONE code path for the dry run and the real one, switched by `apply`. Two paths
   * would let the number a human approved differ from the number that executed, which
   * is the whole risk of a destructive command: the preview must be produced by the
   * code that does the work, not by a second query that resembles it.
   *
   * `vectors` FIRST, and deliberately: its only join key to a file is through
   * `events.uid`, so deleting events first would strand every embedding with no way
   * left to find it. Orphan vectors are invisible — `vectorStats()` counts rows, not
   * reachable ones — so this ordering is the difference between a clean prune and a
   * table that grows forever.
   *
   * Chunked because a Lance filter is a SQL string: an unbounded `IN (...)` over
   * thousands of paths is one enormous predicate. 200 keeps it parseable and still
   * costs one commit per chunk rather than one per file.
   */
  async pruneFiles(paths: string[], apply: boolean): Promise<{ events: number; sessions: number; files: number; vectors: number }> {
    const r = { events: 0, sessions: 0, files: 0, vectors: 0 };
    if (!paths.length) return r;
    const CHUNK = 200;
    const ev = await this.existing("events");
    const se = await this.existing("sessions");
    const fi = await this.existing("files");
    const ve = await this.existing("vectors");
    for (let i = 0; i < paths.length; i += CHUNK) {
      const where = `file_path IN (${paths.slice(i, i + CHUNK).map(sqlStr).join(", ")})`;
      if (ve && ev) {
        const uids = (await ev.query().where(where).select(["uid"]).toArray() as any[]).map(x => String(x.uid));
        for (let j = 0; j < uids.length; j += CHUNK) {
          const w = `uid IN (${uids.slice(j, j + CHUNK).map(sqlStr).join(", ")})`;
          r.vectors += await ve.countRows(w);
          if (apply) await ve.delete(w);
        }
      }
      if (ev) { r.events   += await ev.countRows(where); if (apply) await ev.delete(where); }
      if (se) { r.sessions += await se.countRows(where); if (apply) await se.delete(where); }
      if (fi) { r.files    += await fi.countRows(where); if (apply) await fi.delete(where); }
    }
    return r;
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
  async ensureFtsIndex(opts: { rebuild?: boolean } = {}, config?: (tok: Tokenizer) => Index): Promise<FtsOutcome | null> {
    const t = await this.existing("events");
    if (!t) return null;
    return ensureFts(t, opts, config);
  }

  /** "simple" marks a shard where Thai substring search is degraded; null = no index, LIKE scan. */
  async ftsTokenizer(): Promise<Tokenizer | null> {
    const t = await this.existing("events");
    return t ? tokenizerOf(t) : null;
  }

  /** Full-text search, BM25-ranked. Falls back to a LIKE scan if no index exists yet. */
  async search(q: string, opts: { limit?: number; tier?: string; mainTiers?: boolean; org?: string; project?: string; dir?: string; memType?: string; source?: string; worktree?: string; path?: string; since?: string; until?: string; role?: string; prose?: boolean } = {}): Promise<Hit[]> {
    const t = await this.existing("events");
    if (!t) return [];
    const limit = opts.limit ?? 20;
    const filters: string[] = [];
    if (opts.tier)   filters.push(`tier = ${sqlStr(opts.tier)}`);
    /*
     * The "main" default: the human's own thread plus documents, excluding the
     * subagent/workflow chatter that is 73% of the corpus by file count.
     *
     * THE COLUMN IS ABSENT ON OLD SHARDS, NOT EMPTY — and that distinction is the
     * whole trap. `widen()` adds a column on WRITE, so the 509 shards that predate
     * `kind` have no such field at all. A filter guarding with `kind = ''` still
     * NAMES the column, so the query is invalid SQL there, every shard throws, the
     * per-shard catch swallows it, and the search returns zero matches while
     * reporting a healthy-looking shard count. Measured while building this: 2 of 509
     * shards answered and the result read as "no matches", not as an error.
     *
     * So the schema decides which filter to emit, before any SQL is built. Drop the
     * tier-only branch only once every shard has been rewritten, and check it with a
     * count rather than by reasoning about it.
     */
    else if (opts.mainTiers) filters.push(await this.mainTiersFilter(t));
    if (opts.source) filters.push(`source = ${sqlStr(opts.source)}`);
    // worktree is context, not noise: "which worktree was this said in" is usually
    // the same question as "what was I working on".
    if (opts.worktree) filters.push(`worktree LIKE '%${opts.worktree.replace(/'/g, "''")}%'`);
    if (opts.org)     filters.push(`org = ${sqlStr(opts.org)}`);
    if (opts.project) filters.push(`project = ${sqlStr(opts.project)}`);
    // dir is a PREFIX match: --dir ψ/memory must return ψ/memory/learnings too.
    if (opts.dir)     filters.push(`dir LIKE '${opts.dir.replace(/'/g, "''")}%'`);
    if (opts.memType) filters.push(`mem_type = ${sqlStr(opts.memType)}`);
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
      // FTS lower-cases its tokens; a raw LIKE does not, so fold both sides.
      const where = [`lower(text) LIKE '%${q.toLowerCase().replace(/'/g, "''")}%'`, ...filters];
      return await t.query().where(where.join(" AND ")).limit(limit).toArray() as unknown as Hit[];
    }
  }

  /**
   * List sessions, newest first. A session matches a window it was ACTIVE in — started
   * before it closed, last event after it opened — on its own event timestamps, NOT file
   * mtime, which moves every time a transcript is appended to.
   */
  /**
   * Find a session by NAME rather than id — the host's `title`, falling back to the
   * opening user message. Case-insensitive substring, because nobody retypes a title.
   *
   * `title` may be absent on a shard written before the column existed, so this probes
   * the schema rather than assuming. A missing column is a hard error in a Lance filter,
   * not an empty result — it would take down the whole fan-out.
   */
  async findSessionByName(q: string, limit = 40): Promise<SessionRow[]> {
    const t = await this.existing("sessions");
    if (!t) return [];
    const needle = q.replace(/'/g, "''").toLowerCase();
    const has = (await t.schema()).fields.some(f => f.name === "title");
    const cols = has ? ["title", "description"] : ["description"];
    // tier='session' ONLY. A name belongs to the conversation, not to each of the 122
    // child transcripts that inherit its description — without this, one match floods
    // the result with the same uuid repeated once per file.
    const rows = await t.query()
      .where(`tier = 'session' AND (${cols.map(c => `lower(${c}) LIKE '%${needle}%'`).join(" OR ")})`)
      .toArray() as unknown as SessionRow[];
    rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return rows.slice(0, limit);
  }

  /**
   * Sessions either side of an instant, in time order — the neighbourhood a session
   * sits in. Answers "what else was I doing around then", which a single session row
   * cannot, and which is usually why someone looked the session up at all.
   */
  async around(iso: string, opts: { worktree?: string; before?: number; after?: number } = {}): Promise<{ before: SessionRow[]; after: SessionRow[] }> {
    const t = await this.existing("sessions");
    if (!t) return { before: [], after: [] };
    // Parent transcripts only. Including subagents would bury the neighbours under the
    // dozens of children a single fan-out produced.
    const base = [`tier = 'session'`, `started_at != ''`];
    if (opts.worktree) base.push(`worktree = ${sqlStr(opts.worktree)}`);
    const pull = async (cmp: string, desc: boolean, n: number) => {
      const rows = await t.query().where([...base, `started_at ${cmp} ${sqlStr(iso)}`].join(" AND "))
        .toArray() as unknown as SessionRow[];
      rows.sort((a, b) => desc ? String(b.started_at).localeCompare(String(a.started_at))
                               : String(a.started_at).localeCompare(String(b.started_at)));
      return rows.slice(0, n);
    };
    const before = (await pull("<", true, opts.before ?? 5)).reverse();  // oldest-first for display
    return { before, after: await pull(">", false, opts.after ?? 5) };
  }

  async sessions(opts: { since?: string; until?: string; worktree?: string; limit?: number; tiers?: string[] } = {}): Promise<SessionRow[]> {
    const t = await this.existing("sessions");
    if (!t) return [];
    const where: string[] = [];
    // Overlap, not start-in-window: a session still running inside the window was active in it.
    if (opts.since)    where.push(`(ended_at >= ${sqlStr(opts.since)} OR (ended_at = '' AND started_at >= ${sqlStr(opts.since)}))`);
    if (opts.until)    where.push(`started_at <= ${sqlStr(opts.until)}`);
    if (opts.worktree) where.push(`worktree LIKE '%${opts.worktree.replace(/'/g, "''")}%'`);
    /*
     * TIER, BECAUSE `sessions` HOLDS ONE ROW PER INDEXED FILE — of any kind.
     *
     * A vault note is a row here, and the vault dwarfs everything else. Measured
     * 2026-09-22 with --since 7d over the live index:
     *
     *     42,403  note        <- ψ/*.md, one row each
     *        382  session     <- what anybody asking "how many sessions" means
     *         34  memory
     *          8  subagent
     *
     * So the unfiltered answer to "how many sessions this week" was off by 112x, and
     * the daily histogram showed three enormous spikes that were vault INDEXING runs,
     * not activity. The caller has to say which population it wants.
     */
    if (opts.tiers?.length)
      where.push(`(${opts.tiers.map(x => `tier = ${sqlStr(x)}`).join(" OR ")})`);
    let q = t.query();
    if (where.length) q = q.where(where.join(" AND "));
    const rows = await q.toArray() as unknown as SessionRow[];
    rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  /**
   * Resolve a session id — or a prefix of one — to the transcript files it names.
   *
   * Returns MANY rows on purpose. A session_uuid is not a key: subagent and
   * workflow-agent transcripts inherit the parent's, so one uuid identifies a session
   * TREE. Measured on one shard: 1,881 files carry 153 distinct uuids. A lookup that
   * returned a single row would silently hide every child.
   */
  async findSession(idOrPrefix: string): Promise<SessionRow[]> {
    const t = await this.existing("sessions");
    if (!t) return [];
    const q = idOrPrefix.replace(/'/g, "''");
    const rows = (await t.query()
      .where(`session_uuid LIKE '${q}%' OR file_path LIKE '%${q}%'`)
      .toArray() as unknown as SessionRow[])
      // journal.jsonl is the workflow RUNNER's event log, not a transcript. Discovery
      // has skipped it since 2026-09-18, but rows written before that remain — the
      // index has no prune — so every session tree containing a workflow reports one
      // transcript too many. Measured: 1,353 such rows across this index.
      .filter(r => !String(r.file_path).endsWith("/journal.jsonl"));
    rows.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    return rows;
  }

  /**
   * The "main" predicate, in ONE place. `search` and `embed` must agree on what the
   * human's own thread is, or a backfill embeds a different population than the one
   * search reads back — a disagreement that shows up as recall, not as an error.
   *
   * See the comment that used to live inline in search(): the column is ABSENT on old
   * shards, not empty, so naming it in a filter makes the whole query invalid there.
   * The schema decides the filter before any SQL is built.
   */
  private async mainTiersFilter(t: lancedb.Table): Promise<string> {
    const hasKind = (await t.schema()).fields.some(f => f.name === "kind");
    return hasKind
      ? `((kind = 'transcript' AND tier = 'session')` +
        // note and message are whole-kind includes: a vault note has no tier worth
        // filtering on, and a hermes message is a human conversation, not chatter.
        ` OR kind = 'note' OR kind = 'message'` +
        // rows written by an older build into a shard that HAS the column
        ` OR (kind = '' AND (tier = 'session' OR tier = 'note')))`
      : `(tier = 'session' OR tier = 'note')`;
  }

  /**
   * What is embedded here, and with what. `null` when the table has never been created
   * — which is the normal state, since `index` never writes vectors.
   *
   * `dim` and `model` are read off row 0 rather than trusted from a flag: the table is
   * on disk and outlives whatever the caller thinks it asked for. A shard embedded last
   * week with all-minilm answers honestly after someone changes the default.
   */
  async vectorStats(): Promise<{ rows: number; model: string; dim: number; norm: string } | null> {
    const t = await this.existing("vectors");
    if (!t) return null;
    const rows = await t.countRows();
    if (!rows) return { rows: 0, model: "", dim: 0, norm: "" };
    const [r] = await t.query().select(["model", "dim", "norm"]).limit(1).toArray();
    return { rows, model: String(r?.model ?? ""), dim: Number(r?.dim ?? 0), norm: String(r?.norm ?? "") };
  }

  /**
   * Nearest neighbours in the `vectors` table, resolved back to their events.
   *
   * TWO QUERIES, because LanceDB has no join. The vector table holds only (uid, embedding,
   * model, dim, norm, embedded_at) — deliberately, so `events` never grew a 4.86 GiB
   * column — so a semantic hit is a uid, and the row it names is fetched after.
   *
   * The scalar filter is applied on the SECOND query, which costs recall: asking for the
   * 20 nearest vectors and then dropping the ones whose events fail the filter can return
   * fewer than 20. `overfetch` is the answer, not a pre-filter, because the vectors table
   * has no tier/kind/repo columns to pre-filter ON. Copying them there would duplicate
   * every scalar column into a second table and re-create the coupling the split removed.
   *
   * `_distance` is L2 and the vectors are written L2-normalised (VectorRow.norm), so
   * cosine = 1 - d^2/2 exactly. Reported as `_score` in [0,1] so the number means the
   * same thing as a human expects and sorts the same direction as BM25's.
   */
  async vectorSearch(vec: number[], opts: { limit?: number; overfetch?: number;
                     mainTiers?: boolean; tier?: string; since?: string; until?: string;
                     role?: string; source?: string; session?: string } = {}): Promise<Hit[]> {
    const vt = await this.existing("vectors");
    const et = await this.existing("events");
    if (!vt || !et) return [];
    const limit = opts.limit ?? 20;
    // Overfetch so a post-filter cannot starve the result. 4x is what it took for the
    // main-tiers default to still fill a page on the vault bank; it is a knob, not a law.
    const k = Math.min(2000, Math.max(limit, limit * (opts.overfetch ?? 4)));

    const near = await vt.query().nearestTo(vec).limit(k).toArray();
    if (!near.length) return [];
    const dist = new Map<string, number>();
    for (const r of near) dist.set(String(r.uid), Number((r as any)._distance ?? 0));

    const filters: string[] = [];
    if (opts.session) filters.push(`session_uuid = ${sqlStr(opts.session)}`);
    if (opts.tier) filters.push(`tier = ${sqlStr(opts.tier)}`);
    else if (opts.mainTiers) filters.push(await this.mainTiersFilter(et));
    if (opts.role)   filters.push(`role = ${sqlStr(opts.role)}`);
    if (opts.source) filters.push(`source = ${sqlStr(opts.source)}`);
    if (opts.since)  filters.push(`ts >= ${sqlStr(opts.since)}`);
    if (opts.until)  filters.push(`ts <= ${sqlStr(opts.until)}`);

    // uid IN (...) rather than k round-trips. Quoted through sqlStr: a uid is a hex
    // digest today, and building SQL by concatenation is how that stops being true.
    const inList = [...dist.keys()].map(sqlStr).join(", ");
    filters.push(`uid IN (${inList})`);
    const rows = await et.query().where(filters.join(" AND ")).limit(k).toArray();

    const out = rows.map(r => {
      const d = dist.get(String(r.uid)) ?? 0;
      // L2 on unit vectors: d^2 = 2 - 2cos. Clamped because float error puts a perfect
      // match a hair below 0, and a score of -1e-9 sorts fine but reads as a bug.
      const cos = Math.max(0, Math.min(1, 1 - (d * d) / 2));
      return { ...(r as unknown as Hit), _score: cos } as Hit;
    });
    out.sort((a, b) => Number((b as any)._score) - Number((a as any)._score));
    return out.slice(0, limit);
  }

  /**
   * Every event matching a raw filter, seq-ordered by the caller.
   *
   * Exists so callers stop reaching into `existing("events")` through an `as any` cast
   * — which compiles, works, and silently couples them to a private. The filter is a
   * SQL string like the rest of this file; build it with sqlStr(), never by
   * concatenating user input.
   */
  async eventsWhere(where: string, limit = 200_000): Promise<Hit[]> {
    const t = await this.existing("events");
    if (!t) return [];
    return (await t.query().where(where).limit(limit).toArray()) as unknown as Hit[];
  }

  /** Every uid that already has a vector. The anti-join key for a resumable backfill. */
  async embeddedUids(): Promise<Set<string>> {
    const t = await this.existing("vectors");
    if (!t) return new Set();
    const out = new Set<string>();
    for (const r of await t.query().select(["uid"]).toArray()) out.add(String(r.uid));
    return out;
  }

  /**
   * Events with no vector yet, oldest-slot first.
   *
   * LanceDB has no join, so the anti-join is done in memory against `embeddedUids()`.
   * That is affordable BECAUSE this runs per shard: the biggest shard in the live index
   * holds well under a million uids, not the 3.4 M of the whole corpus.
   *
   * `minChars` is not tidiness. A two-character event embeds to a vector that is close
   * to everything, so it pollutes every result list while carrying no meaning — and it
   * costs the same to compute as a real one.
   */
  async unembedded(opts: { limit?: number; mainTiers?: boolean; minChars?: number; session?: string } = {}): Promise<{ uid: string; text: string }[]> {
    const t = await this.existing("events");
    if (!t) return [];
    const done = await this.embeddedUids();
    const minChars = opts.minChars ?? 24;
    let q = t.query().select(["uid", "text", "seq"]);
    // ONE session is the unit a handoff cares about: after /forward + /new the next
    // session wants the previous one queryable, not the whole 5.8 M-event corpus.
    // 12,046 events is 19 MB of vectors and ~40 s — the whole corpus is 8.3 GiB.
    const filters = [
      opts.session ? `session_uuid = ${sqlStr(opts.session)}` : "",
      opts.mainTiers ? await this.mainTiersFilter(t) : "",
    ].filter(Boolean);
    if (filters.length) q = q.where(filters.join(" AND "));
    const out: { uid: string; text: string }[] = [];
    const limit = opts.limit ?? Infinity;
    for (const r of await q.toArray()) {
      const uid = String(r.uid);
      if (done.has(uid)) continue;
      const text = String(r.text ?? "");
      if (text.length < minChars) continue;
      out.push({ uid, text });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** How many events are eligible, ignoring what is already done — the denominator. */
  async embeddableCount(opts: { mainTiers?: boolean; minChars?: number; session?: string } = {}): Promise<number> {
    const t = await this.existing("events");
    if (!t) return 0;
    const minChars = opts.minChars ?? 24;
    let q = t.query().select(["text"]);
    const filters = [
      opts.session ? `session_uuid = ${sqlStr(opts.session)}` : "",
      opts.mainTiers ? await this.mainTiersFilter(t) : "",
    ].filter(Boolean);
    if (filters.length) q = q.where(filters.join(" AND "));
    let n = 0;
    for (const r of await q.toArray()) if (String(r.text ?? "").length >= minChars) n++;
    return n;
  }

  /**
   * The embeddable population, as (role, text) — what `relic langs` measures.
   *
   * SAME eligibility as embeddableCount and unembedded: main tiers when asked, length
   * filtered here rather than in SQL, so the language mix describes exactly the text a
   * model would be fed. `where` narrows it further — `relic langs` passes a uid range,
   * which is a uniform sample because a uid is a sha1.
   */
  async langRows(opts: { where?: string; mainTiers?: boolean; minChars?: number; maxChars?: number } = {}): Promise<{ role: string; text: string }[]> {
    const t = await this.existing("events");
    if (!t) return [];
    const minChars = opts.minChars ?? 24;
    let q = t.query().select(["role", "text"]);
    const filters = [opts.where ?? "", opts.mainTiers ? await this.mainTiersFilter(t) : ""].filter(Boolean);
    if (filters.length) q = q.where(filters.join(" AND "));
    const out: { role: string; text: string }[] = [];
    for (const r of await q.toArray()) {
      const text = String(r.text ?? "");
      // Eligibility on the full length, as embed decides it; keep only the slice embed sends,
      // so `--sample 1` over a big shard does not hold every event's full text at once.
      if (text.length >= minChars) out.push({ role: String(r.role ?? ""), text: opts.maxChars ? text.slice(0, opts.maxChars) : text });
    }
    return out;
  }

  async counts(): Promise<{ events: number; sessions: number; files: number }> {
    const names = await this.db.tableNames();
    const n = async (x: string) => names.includes(x) ? await (await this.db.openTable(x)).countRows() : 0;
    return { events: await n("events"), sessions: await n("sessions"), files: await n("files") };
  }

  /**
   * Two different "when", and conflating them is the trap.
   *
   * `lastIndexed` is max(files.imported_at) — when the INDEXER last wrote here. It answers
   * "did my index run land". `newestSession` is max(sessions.started_at) — when the newest
   * transcript in this shard BEGAN. It answers "how recent is the material".
   *
   * They diverge in the case that matters: reindexing an old corpus moves lastIndexed to
   * now and leaves newestSession months back, and a stale index that has not run since
   * Tuesday shows a fresh newestSession only because a session started before it ran.
   */
  async freshness(): Promise<{ lastIndexed: string; newestSession: string }> {
    const max = async (table: string, col: string) => {
      const t = await this.existing(table);
      if (!t) return "";
      try {
        const rows = await t.query().select([col]).toArray() as any[];
        let best = "";
        for (const r of rows) { const v = String(r[col] ?? ""); if (v > best) best = v; }
        return best;
      } catch { return ""; }
    };
    return { lastIndexed: await max("files", "imported_at"),
             newestSession: await max("sessions", "started_at") };
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

  /**
   * Every Claude Code memory row in this shard — a filter-only read, never FTS.
   *
   * `search("")` cannot answer this: an empty query against a full-text index matches
   * nothing by construction, so it reports zero for a shard that is actually full.
   *
   * The schema probe is not defensive padding. `mem_type` arrived with `widen()`, so
   * any shard written before it lacks the column, and a Lance `select` naming a missing
   * column is a HARD ERROR, not an empty result — it would take down the whole fan-out.
   */
  async memories(): Promise<{ session_uuid: string; file_path: string; mem_type: string; origin_session: string; ts: string; text: string }[]> {
    const t = await this.existing("events");
    if (!t) return [];
    const have = new Set((await t.schema()).fields.map(f => f.name));
    if (!have.has("mem_type")) return [];
    return await t.query().where("tier = 'memory'")
      .select(["session_uuid", "file_path", "mem_type", "origin_session", "ts", "text"])
      .toArray() as any;
  }

  /** The session ids this shard holds — the right-hand side of the memory join. */
  async sessionIds(): Promise<Set<string>> {
    const t = await this.existing("sessions");
    if (!t) return new Set();
    const rows = await t.query().select(["session_uuid"]).toArray() as any[];
    return new Set(rows.map(r => String(r.session_uuid)));
  }

  /** Indexed transcript count, excluding the document tiers that are not sessions. */
  async transcriptCount(): Promise<number> {
    const t = await this.existing("sessions");
    if (!t) return 0;
    const rows = await t.query().select(["tier"]).toArray() as any[];
    return rows.filter(r => r.tier !== "note" && r.tier !== "memory").length;
  }
}
