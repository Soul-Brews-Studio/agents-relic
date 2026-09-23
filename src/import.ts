import { LanceStore, type EventRow, type SessionRow, type FileRow } from "./store/lance.js";
import type { Found } from "./discover.js";
import { classify, logSkipped } from "./noise.js";
import { kindOf } from "./discover.js";
import { resolveRepoKey, repoKeyOf, contextOf, locationOf, shardDirFor, guardShardDir, DEFAULT_BANK } from "./repo.js";

/**
 * Writing into the index.
 *
 * This lives apart from cli.ts because `session`, `chain` and the MCP server all need
 * the SEEK -> INDEX -> ANSWER path, and cli.ts runs a command at import time — anything
 * that imports it to reuse one function would execute the CLI as a side effect.
 */

const nowISO = () => new Date().toISOString();
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * One store per (BANK, repo), opened on first write.
 *
 * Keying on the repo alone would hand the same LanceStore to two banks, and every row
 * would land in whichever bank happened to open first — silently, since both writes
 * succeed. The three Claude roots overlap by 742 sessions, so that is not hypothetical.
 */
/**
 * The (bank, repo) a parsed file belongs to, as one string.
 *
 * NUL separator: never legal in either part, so the key cannot be ambiguous and cannot
 * be produced by concatenation elsewhere by accident.
 *
 * Exported because `prune` must group discovery by the SAME rule the importer grouped
 * the rows by. A second copy that merely resembles this line would send prune at the
 * wrong shard and delete rows it never compared.
 */
export function shardKeyFor(bank: string, repoKey: string | null): string {
  return `${bank}\u0000${repoKey ?? "_unresolved"}`;
}

/** Split a shard key back apart — for display and for reopening a store. */
export function splitShardKey(key: string): { bank: string; repo: string } {
  const i = key.indexOf("\u0000");
  return { bank: key.slice(0, i), repo: key.slice(i + 1) };
}

export class Shards {
  private pool = new Map<string, LanceStore>();
  constructor(private dataRoot: string | null, private inRepo = false) {}
  async get(repoKey: string | null, bank = DEFAULT_BANK): Promise<LanceStore> {
    const key = shardKeyFor(bank, repoKey);
    let s = this.pool.get(key);
    if (!s) {
      const dir = shardDirFor(repoKey, this.dataRoot, this.inRepo, bank);
      guardShardDir(dir);
      s = await LanceStore.open(dir);
      this.pool.set(key, s);
    }
    return s;
  }
  get size() { return this.pool.size; }
  keys() { return [...this.pool.keys()]; }
  /**
   * The store for a key this pool already opened, or undefined.
   *
   * Prune needs the store that WROTE a shard, not one reopened from a key it parsed
   * back apart. Zipping keys() against stores() would work today and break the first
   * time either is filtered.
   */
  byKey(key: string) { return this.pool.get(key); }
  /** The open stores themselves — for callers that must not re-derive a key to reopen. */
  stores() { return [...this.pool.values()]; }
}

export interface ImportOpts {
  dataRoot: string | null; inRepo: boolean; skipNoise?: boolean;
  repoFilter?: string | null; verbose?: boolean; progress?: boolean;
  /**
   * Resolve every file to its shard and write NOTHING.
   *
   * This is `prune`'s scan. It exists here rather than in prune.ts so that the mapping
   * from a file to a shard is produced by the importer itself — the same parse, the
   * same resolveRepoKey, the same shardKeyFor. Prune deletes rows the importer wrote,
   * so any divergence between the two mappings is a deletion in the wrong shard.
   */
  noWrite?: boolean;
}
export interface ImportTally {
  added: number; skipped: number; failed: number; filtered: number;
  skippedNoise: number; done: number; imported: number; shards: Shards;
  /**
   * Every file DISCOVERED this run, grouped by shard key — including the ones skipped
   * as unchanged, which are the overwhelming majority on a repeat run and are exactly
   * the files prune must not delete.
   */
  seen: Map<string, Set<string>>;
  /** FTS indexes actually built or confirmed, and what that phase cost. */
  ftsBuilt: number; ftsFailed: number; ftsMs: number;
  /** "bank/repo" of shards left on the `simple` tokenizer, and why ICU was refused. */
  ftsSimple: string[]; ftsNoIcu: string; ftsUpgraded: number;
}

/**
 * Import a list of files. Shared by `index` and by the seek-then-index path, so an
 * on-demand import of one file behaves identically to a bulk run — same skip rules,
 * same noise filter, same manifest write.
 */
export async function importFiles(found: Found[], o: ImportOpts, t0 = Date.now()): Promise<ImportTally> {
  const shards = new Shards(o.dataRoot, o.inRepo);
  const manifests = new Map<string, Map<string, { mtime: number; size: number }>>();
  let added = 0, skipped = 0, failed = 0, done = 0, filtered = 0, skippedNoise = 0, imported = 0;
  const seen = new Map<string, Set<string>>();

  /*
   * BATCHED WRITES.
   *
   * Each `mergeInsert` is a versioned commit in LanceDB. Writing events+session+file
   * per FILE means 3 commits per file, which is negligible for JSONL transcripts (few
   * files, thousands of events each) and pathological for document sources (many
   * files, ~1 event each).
   *
   * Measured before this change, same code both times:
   *   omp          19 files ->  6,173 events   ~1,200 events/sec
   *   oracle-vault 10,058 files -> ~10,058 events    5 files/sec  (ETA 32 min, 19 MB)
   *
   * Accumulating and flushing every FLUSH_EVERY files turns ~30,000 commits into ~40.
   *
   * Resume semantics: `putFile` is what marks a file done, and it is flushed in the
   * SAME batch as its events — so an interrupt loses at most one batch, and those
   * files are simply re-imported next run. Granularity moves from 1 file to N; the
   * invariant "a file is only marked done once its rows are committed" still holds.
   */
  const FLUSH_EVERY = 250;
  // The batch carries its own store. The shard key is now (bank, repo), and re-deriving
  // a store from that string in flush() would mean parsing the key back apart — the exact
  // shape of bug this change exists to remove.
  interface Pending { store: LanceStore; events: EventRow[]; sessions: SessionRow[]; files: FileRow[]; deletes: string[] }
  const pending = new Map<string, Pending>();
  const pend = (k: string, store: LanceStore): Pending => {
    let b = pending.get(k);
    if (!b) { b = { store, events: [], sessions: [], files: [], deletes: [] }; pending.set(k, b); }
    return b;
  };

  async function flush(): Promise<void> {
    for (const b of pending.values()) {
      if (!b.events.length && !b.sessions.length && !b.files.length && !b.deletes.length) continue;
      const store = b.store;
      // Deletes FIRST and as a unit: a re-imported file must drop its old rows before
      // the new ones land, or the two generations coexist.
      for (const fp of b.deletes) await store.deleteEventsOf(fp);
      // One commit per TABLE per batch — not per row. Looping putSession/putFile here
      // was the original bug in this fix: it batched events and left the other two
      // committing per row, so a 250-file batch still cost 500 commits.
      // Defensive dedup by uid, keeping the LAST occurrence.
      //
      // mergeInsert rejects a batch outright if two source rows target the same key
      // ("Ambiguous merge inserts are prohibited") — and it fails the WHOLE batch, not
      // the offending row. Per-file writes could never hit this; batching can, for any
      // source whose uid scheme is not unique within a batch. One bad pair must not
      // discard 250 files' work.
      if (b.events.length) {
        const byUid = new Map<string, EventRow>();
        for (const e of b.events) byUid.set(e.uid, e);
        await store.putEvents([...byUid.values()]);
      }
      if (b.sessions.length) await store.putSessions(b.sessions);
      if (b.files.length)    await store.putFiles(b.files);
      b.events = []; b.sessions = []; b.files = []; b.deletes = [];
    }
  }

  /**
   * One progress line, naming what the numbers MEAN.
   *
   * `scanned` is every file looked at; `imported` is the subset that needed writing.
   * Printing only the second against a total of the first is what made a healthy run
   * look dead. The ETA uses the scan rate, which is the thing that actually paces the
   * run — an unchanged file still costs a parse.
   */
  const progressTick = () => {
    const secs = (Date.now() - t0) / 1000;
    const rate = secs > 0 ? done / secs : 0;
    const eta = rate > 0 ? Math.round((found.length - done) / rate) : 0;
    const pct = Math.round((done / Math.max(1, found.length)) * 100);
    process.stderr.write(
      `\r  ${String(pct).padStart(3)}%  ${fmt(done)}/${fmt(found.length)} scanned` +
      `  ${fmt(imported)} imported  ${fmt(skipped)} unchanged  ${fmt(added)} events` +
      `  ${shards.size} shards  ${rate.toFixed(0)}/s  eta ${eta}s   `);
  };

  let sinceFlush = 0;

  for (const file of found) {
    /*
     * COUNT THE FILE HERE, not at the bottom.
     *
     * Every `continue` below — unchanged, filtered, noWrite — used to skip the
     * bottom-of-loop increment, so `done` counted only files this run IMPORTED while
     * the denominator counted every file DISCOVERED. On a re-index, where unchanged is
     * the overwhelming majority, that reads as a stalled run:
     *
     *     0%  100/206,680 files  32,100 events  56 shards  3/s  eta 61317s
     *
     * observed at 82% CPU with zero shards written in three minutes. The run was fine;
     * the counter had moved 100 times because it had written 100 files. The rate and
     * the ETA are both derived from it, so both were fiction — 61,317s is 17 hours.
     */
    done++;
    if (o.progress && done % 100 === 0) progressTick();
    try {
      const p = await file.parser(file.path);
      const repoKey = resolveRepoKey(p.cwd);
      if (o.repoFilter && !(repoKey ?? "").includes(o.repoFilter)) { filtered++; continue; }

      // `repoCol` is what goes in the rows; `shardKey` is (bank, repo) and only ever
      // names a batch. The bank is NOT written into repo_key — it is already the
      // directory the row lives in, and duplicating it would make every existing
      // `--repo` filter match bank names too.
      const repoCol = repoKey ?? "_unresolved";
      const shardKey = shardKeyFor(file.bank, repoKey);
      const store = await shards.get(repoKey, file.bank);

      // BEFORE the unchanged-skip below. A file skipped as unchanged is still present
      // on disk, and prune's question is "is it still discoverable", not "did this run
      // rewrite it".
      let sset = seen.get(shardKey);
      if (!sset) { sset = new Set<string>(); seen.set(shardKey, sset); }
      sset.add(file.path);

      if (o.noWrite) continue;      // counted at the top of the loop, like every path

      const ctx = contextOf(p.cwd);
      const loc = locationOf(p.cwd);

      if (!manifests.has(shardKey)) manifests.set(shardKey, await store.manifest());
      const man = manifests.get(shardKey)!;
      // `known`, not `seen`: the run-wide `seen` map is read earlier in this same
      // block, and a second block-scoped `const seen` puts it in the temporal dead
      // zone for the whole block — every file threw ReferenceError, and the importer
      // reported them as parse failures.
      const known = man.get(file.path);
      if (known && known.mtime === file.mtime && known.size === file.size) { skipped++; continue; }

      const dropped: any[] = [];
      const kept = o.skipNoise
        ? p.events.filter(e => {
            const v = classify(e.text, e.role);
            if (v.skip) dropped.push({ uid: e.uid, file_path: file.path, seq: e.seq, role: e.role,
              rule: v.rule, bytes: e.text.length, head: e.text.replace(/\s+/g, " ").slice(0, 120) });
            return !v.skip;
          })
        : p.events;
      skippedNoise += dropped.length;
      if (dropped.length) logSkipped(dropped, o.dataRoot);

      const events: EventRow[] = kept.map(e => ({
        uid: e.uid, session_uuid: p.sessionUuid, file_path: file.path, repo_key: repoCol,
        seq: e.seq, role: e.role, ts: e.ts ?? "", text: e.text,
        source: file.source, tier: file.tier, kind: kindOf(file.tier, file.source),
        // The EVENT's own cwd, falling back to the session's. Shards and repo_key
        // still come from p.cwd, so this changes what is findable, never where a
        // row lives — see ParsedEvent.cwd.
        worktree: ctx.worktree, cwd: e.cwd ?? p.cwd ?? "",
        org: loc.org, project: loc.project, dir: loc.dir,
        mem_type: String((p as any).memType ?? ""),
        origin_session: String((p as any).originSessionId ?? ""),
      }));

      const batch = pend(shardKey, store);
      if (known) batch.deletes.push(file.path);
      batch.events.push(...events);
      batch.sessions.push({
        session_uuid: p.sessionUuid, file_path: file.path, repo_key: repoCol,
        project_dir: file.projectDir, tier: file.tier, source: file.source,
        cwd: p.cwd ?? "", model: p.model ?? "", worktree: ctx.worktree,
        workflow_run_id: file.workflowRunId ?? "", agent_id: file.agentId ?? "",
        file_mtime: file.mtime, file_size: file.size,
        line_count: p.lines, event_count: kept.length, bad_lines: p.badLines,
        started_at: p.startedAt ?? "", ended_at: p.endedAt ?? "",
        description: p.description ?? "", title: p.title ?? "", git_branch: p.gitBranch ?? "", imported_at: nowISO(),
      });
      batch.files.push({ file_path: file.path, repo_key: repoCol, mtime: file.mtime, size: file.size, imported_at: nowISO() });
      man.set(file.path, { mtime: file.mtime, size: file.size });
      added += events.length;
      imported++;
      if (++sinceFlush >= FLUSH_EVERY) { await flush(); sinceFlush = 0; }
    } catch (err) {
      failed++;
      if (o.verbose) process.stderr.write(`  FAIL ${file.path}: ${String(err).slice(0, 160)}\n`);
    }
  }
  if (o.progress && done >= 100) process.stderr.write("\r" + " ".repeat(96) + "\r");

  // A scan writes nothing, so there is nothing to flush and no index to rebuild.
  if (o.noWrite)
    return { added, skipped, failed, filtered, skippedNoise, done, imported, shards, seen,
             ftsBuilt: 0, ftsFailed: 0, ftsMs: 0,
             ftsSimple: [], ftsNoIcu: "", ftsUpgraded: 0 };

  await flush();   // anything left below the batch threshold

  /*
   * THE FTS PHASE IS THE QUIET ONE, and quiet is what gets a run killed.
   *
   * It happens after the last flush, after the progress line has been erased, and at
   * ~900 shards it is not instant. A run killed here leaves shards that still ANSWER —
   * `search` catches the missing-index error and falls back to a LIKE scan, 7-28x slower
   * with no `_score` — so the index looks complete and silently ranks wrong. The old code
   * printed a hardcoded "fts index built in 0.0s", which is the same lie with a number.
   */
  const tf0 = Date.now();
  const keys = shards.keys();
  let ftsBuilt = 0, ftsFailed = 0, ftsUpgraded = 0, ftsNoIcu = "";
  const ftsSimple: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    if (o.progress) process.stderr.write(`\r  building full-text index  ${i + 1}/${keys.length} shards   `);
    try {
      const r = await shards.byKey(keys[i])!.ensureFtsIndex();
      ftsBuilt++;
      if (r?.upgraded) ftsUpgraded++;
      if (r?.tokenizer === "simple") {
        const { bank, repo } = splitShardKey(keys[i]);
        ftsSimple.push(`${bank}/${repo}`);
        ftsNoIcu ||= r.fellBack ?? "";
      }
    }
    catch (err) {
      ftsFailed++;
      if (o.verbose) process.stderr.write(`\n  FTS FAIL: ${String(err).slice(0, 160)}\n`);
    }
  }
  if (o.progress && keys.length) process.stderr.write("\r" + " ".repeat(60) + "\r");
  return { added, skipped, failed, filtered, skippedNoise, done, imported, shards, seen,
           ftsBuilt, ftsFailed, ftsMs: Date.now() - tf0, ftsSimple, ftsNoIcu, ftsUpgraded };
}
