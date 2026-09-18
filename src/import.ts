import { LanceStore, type EventRow, type SessionRow, type FileRow } from "./store/lance.js";
import type { Found } from "./discover.js";
import { classify, logSkipped } from "./noise.js";
import { repoKeyOf, contextOf, locationOf, shardDirFor, guardShardDir } from "./repo.js";

/**
 * Writing into the index.
 *
 * This lives apart from cli.ts because `session`, `chain` and the MCP server all need
 * the SEEK -> INDEX -> ANSWER path, and cli.ts runs a command at import time — anything
 * that imports it to reuse one function would execute the CLI as a side effect.
 */

const nowISO = () => new Date().toISOString();
const fmt = (n: number) => n.toLocaleString("en-US");

/** One store per repo, opened on first write. */
export class Shards {
  private pool = new Map<string, LanceStore>();
  constructor(private dataRoot: string | null, private inRepo = false) {}
  async get(repoKey: string | null): Promise<LanceStore> {
    const key = repoKey ?? "_unresolved";
    let s = this.pool.get(key);
    if (!s) {
      const dir = shardDirFor(repoKey, this.dataRoot, this.inRepo);
      guardShardDir(dir);
      s = await LanceStore.open(dir);
      this.pool.set(key, s);
    }
    return s;
  }
  get size() { return this.pool.size; }
  keys() { return [...this.pool.keys()]; }
}

export interface ImportOpts {
  dataRoot: string | null; inRepo: boolean; skipNoise?: boolean;
  repoFilter?: string | null; verbose?: boolean; progress?: boolean;
}
export interface ImportTally {
  added: number; skipped: number; failed: number; filtered: number;
  skippedNoise: number; done: number; imported: number; shards: Shards;
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
  interface Pending { events: EventRow[]; sessions: SessionRow[]; files: FileRow[]; deletes: string[] }
  const pending = new Map<string, Pending>();
  const pend = (k: string): Pending => {
    let b = pending.get(k);
    if (!b) { b = { events: [], sessions: [], files: [], deletes: [] }; pending.set(k, b); }
    return b;
  };

  async function flush(): Promise<void> {
    for (const [shardKey, b] of pending) {
      if (!b.events.length && !b.sessions.length && !b.files.length && !b.deletes.length) continue;
      const store = await shards.get(shardKey === "_unresolved" ? null : shardKey);
      // Deletes FIRST and as a unit: a re-imported file must drop its old rows before
      // the new ones land, or the two generations coexist.
      for (const fp of b.deletes) await store.deleteEventsOf(fp);
      // One commit per TABLE per batch — not per row. Looping putSession/putFile here
      // was the original bug in this fix: it batched events and left the other two
      // committing per row, so a 250-file batch still cost 500 commits.
      if (b.events.length)   await store.putEvents(b.events);
      if (b.sessions.length) await store.putSessions(b.sessions);
      if (b.files.length)    await store.putFiles(b.files);
      b.events = []; b.sessions = []; b.files = []; b.deletes = [];
    }
  }

  let sinceFlush = 0;

  for (const file of found) {
    try {
      const p = await file.parser(file.path);
      const repoKey = repoKeyOf(p.cwd);
      if (o.repoFilter && !(repoKey ?? "").includes(o.repoFilter)) { filtered++; continue; }

      const shardKey = repoKey ?? "_unresolved";
      const ctx = contextOf(p.cwd);
      const loc = locationOf(p.cwd);
      const store = await shards.get(repoKey);

      if (!manifests.has(shardKey)) manifests.set(shardKey, await store.manifest());
      const man = manifests.get(shardKey)!;
      const seen = man.get(file.path);
      if (seen && seen.mtime === file.mtime && seen.size === file.size) { skipped++; continue; }

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
        uid: e.uid, session_uuid: p.sessionUuid, file_path: file.path, repo_key: shardKey,
        seq: e.seq, role: e.role, ts: e.ts ?? "", text: e.text,
        source: file.source, tier: file.tier,
        worktree: ctx.worktree, cwd: p.cwd ?? "",
        org: loc.org, project: loc.project, dir: loc.dir,
      }));

      const batch = pend(shardKey);
      if (seen) batch.deletes.push(file.path);
      batch.events.push(...events);
      batch.sessions.push({
        session_uuid: p.sessionUuid, file_path: file.path, repo_key: shardKey,
        project_dir: file.projectDir, tier: file.tier, source: file.source,
        cwd: p.cwd ?? "", model: p.model ?? "", worktree: ctx.worktree,
        workflow_run_id: file.workflowRunId ?? "", agent_id: file.agentId ?? "",
        file_mtime: file.mtime, file_size: file.size,
        line_count: p.lines, event_count: kept.length, bad_lines: p.badLines,
        started_at: p.startedAt ?? "", ended_at: p.endedAt ?? "",
        description: p.description ?? "", title: p.title ?? "", git_branch: p.gitBranch ?? "", imported_at: nowISO(),
      });
      batch.files.push({ file_path: file.path, repo_key: shardKey, mtime: file.mtime, size: file.size, imported_at: nowISO() });
      man.set(file.path, { mtime: file.mtime, size: file.size });
      added += events.length;
      imported++;
      if (++sinceFlush >= FLUSH_EVERY) { await flush(); sinceFlush = 0; }
    } catch (err) {
      failed++;
      if (o.verbose) process.stderr.write(`  FAIL ${file.path}: ${String(err).slice(0, 160)}\n`);
    }
    if (o.progress && ++done % 100 === 0) {
      const pct = Math.round((done / found.length) * 100);
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = rate > 0 ? Math.round((found.length - done) / rate) : 0;
      process.stderr.write(
        `\r  ${String(pct).padStart(3)}%  ${fmt(done)}/${fmt(found.length)} files` +
        `  ${fmt(added)} events  ${shards.size} shards` +
        `  ${rate.toFixed(0)}/s  eta ${eta}s   `);
    } else if (!o.progress) done++;
  }
  if (o.progress && done >= 100) process.stderr.write("\r" + " ".repeat(96) + "\r");

  await flush();   // anything left below the batch threshold

  for (const key of shards.keys()) {
    try { await (await shards.get(key === "_unresolved" ? null : key)).ensureFtsIndex(); } catch {}
  }
  return { added, skipped, failed, filtered, skippedNoise, done, imported, shards };
}
