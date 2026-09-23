import * as lancedb from "@lancedb/lancedb";
import { ensureFtsIndex, type Tokenizer } from "./store/fts.js";
import { resolveRepoKey, repoKeyOf, contextOf, cwdOfFile } from "./repo.js";

/**
 * Attach to a LanceDB someone else owns — today that means lanceglass — and add the
 * two things it lacks, without copying a single row.
 *
 *   1. an ICU full-text index on its own `events.text` column
 *   2. a `relic_facets` sidecar table: event_id -> repo_key, worktree
 *
 * Why this rather than a second index: lanceglass's event model is better than
 * anything worth re-deriving. It is block-level, content-addressed by `text_hash`,
 * and `event_sources` records MANY observations per canonical event — so the same
 * turn seen in a session file, a subagent file and an archive copy is one event with
 * three provenance rows, not three duplicates. Re-ingesting that into a second store
 * would throw the dedup away and then try to reinvent it.
 *
 * So: lanceglass owns ingest, storage and the UI. relic owns search.
 *
 * THIS WRITES TO LANCEGLASS'S DATABASE. An earlier version of this comment claimed it
 * did not; that was false. `createIndex` mutates their `events` table's metadata and
 * `relic_facets` is a new table in their directory. Naming it honestly matters because
 * lanceglass is itself never read-only either — `src/database.plain.ts` calls
 * `create()` on every read, so merely inspecting a foreign LanceDB writes tables into
 * it. Point neither tool at a directory you do not own.
 */

export interface AttachResult {
  dir: string;
  events: number;
  ftsBuiltMs: number;
  tokenizer: Tokenizer;
  facets: number;
  repos: number;
  worktrees: number;
  skippedNoPath: number;
}

/**
 * Recover a session's working directory — from the JSONL, never from a directory name
 * and never from a database column.
 *
 * THE JSONL IS THE SOURCE OF TRUTH. Derived stores are views we can learn from, but
 * they cannot answer identity:
 *
 *   - the project dir name maps BOTH "/" and "." to "-", so it is lossy and NOT
 *     reversible. A blind s|-|/| turns "acme/my-repo" into "acme/my/repo".
 *     (This function previously did exactly that. Every facet row was wrong.)
 *   - lanceglass's `events.project` is "homelab.wt-1-openclaw-guide" — repo and
 *     worktree, but the ORG is already gone, so it cannot produce a repo key either.
 *
 * The `cwd` field inside the transcript is unambiguous, so read that. One read per
 * distinct FILE (not per event), memoised.
 */

export async function attach(dir: string, opts: { rebuild?: boolean } = {}): Promise<AttachResult> {
  const db = await lancedb.connect(dir);
  const names = await db.tableNames();
  if (!names.includes("events")) throw new Error(`no 'events' table in ${dir} — is this a lanceglass database?`);

  const events = await db.openTable("events");
  const total = await events.countRows();

  // 1. the full-text index, on their column
  const t0 = Date.now();
  const { tokenizer } = await ensureFtsIndex(events, { rebuild: opts.rebuild });
  const ftsBuiltMs = Date.now() - t0;

  // 2. the facets sidecar, derived from their provenance table
  const rows: Record<string, unknown>[] = [];
  const repos = new Set<string>(), worktrees = new Set<string>();
  let skippedNoPath = 0;

  if (names.includes("event_sources")) {
    const src = await db.openTable("event_sources");
    const seen = new Set<string>();
    for (const r of await src.query().select(["event_id", "file_path", "source"]).toArray() as any[]) {
      const eid = String(r.event_id);
      if (seen.has(eid)) continue;          // one facet row per canonical event
      const cwd = await cwdOfFile(String(r.file_path ?? ""));
      if (!cwd) { skippedNoPath++; continue; }
      const repo_key = resolveRepoKey(cwd) ?? "_unresolved";
      const { worktree } = contextOf(cwd);
      seen.add(eid);
      repos.add(repo_key);
      if (worktree) worktrees.add(worktree);
      rows.push({ event_id: eid, repo_key, worktree, agent: String(r.source ?? ""), cwd });
    }
  }

  if (rows.length) {
    if (names.includes("relic_facets")) {
      const t = await db.openTable("relic_facets");
      await t.mergeInsert("event_id").whenMatchedUpdateAll().whenNotMatchedInsertAll().execute(rows);
    } else {
      const t = await db.createTable("relic_facets", rows);
      if ((await t.countRows()) === 0) throw new Error("created relic_facets but it holds 0 rows");
    }
  }

  return { dir, events: total, ftsBuiltMs, tokenizer, facets: rows.length, repos: repos.size, worktrees: worktrees.size, skippedNoPath };
}

export interface AttachedHit {
  id: string; text: string; timestamp: string; session_id: string;
  semantic_role: string; block_type: string; source: string; project: string;
  repo_key: string; worktree: string;
}

/** Search an attached database: their FTS, our facets. */
export async function searchAttached(
  dir: string,
  q: string,
  opts: { limit?: number; repo?: string; worktree?: string; role?: string } = {},
): Promise<AttachedHit[]> {
  const db = await lancedb.connect(dir);
  const events = await db.openTable("events");
  const limit = opts.limit ?? 20;

  // Over-fetch when a facet filter is present: the filter lives in a different table,
  // so it cannot be pushed into the FTS scan and has to be applied after the join.
  const wantFacet = Boolean(opts.repo || opts.worktree);
  const raw = await events.search(q, "fts").limit(wantFacet ? limit * 8 : limit).toArray() as any[];
  if (!raw.length) return [];

  let facets = new Map<string, { repo_key: string; worktree: string }>();
  if ((await db.tableNames()).includes("relic_facets")) {
    const t = await db.openTable("relic_facets");
    const ids = raw.map(r => `'${String(r.id).replace(/'/g, "''")}'`).join(",");
    for (const f of await t.query().where(`event_id IN (${ids})`).toArray() as any[])
      facets.set(String(f.event_id), { repo_key: String(f.repo_key), worktree: String(f.worktree ?? "") });
  }

  const out: AttachedHit[] = [];
  for (const r of raw) {
    const f = facets.get(String(r.id)) ?? { repo_key: "", worktree: "" };
    if (opts.repo && !f.repo_key.includes(opts.repo)) continue;
    if (opts.worktree && !f.worktree.includes(opts.worktree)) continue;
    if (opts.role && String(r.semantic_role) !== opts.role) continue;
    out.push({
      id: String(r.id), text: String(r.text ?? ""), timestamp: String(r.timestamp ?? ""),
      session_id: String(r.session_id ?? ""), semantic_role: String(r.semantic_role ?? ""),
      block_type: String(r.block_type ?? ""), source: String(r.source ?? ""),
      project: String(r.project ?? ""), repo_key: f.repo_key, worktree: f.worktree,
    });
    if (out.length >= limit) break;
  }
  return out;
}
