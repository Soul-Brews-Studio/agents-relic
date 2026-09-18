import { LanceStore, type EventRow } from "./store/lance.js";
import type { Found } from "./discover.js";
import { classify, logSkipped } from "./noise.js";
import { repoKeyOf, contextOf, shardDirFor, guardShardDir } from "./repo.js";

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

  for (const file of found) {
    try {
      const p = await file.parser(file.path);
      const repoKey = repoKeyOf(p.cwd);
      if (o.repoFilter && !(repoKey ?? "").includes(o.repoFilter)) { filtered++; continue; }

      const shardKey = repoKey ?? "_unresolved";
      const ctx = contextOf(p.cwd);
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
      }));

      if (seen) await store.deleteEventsOf(file.path);
      await store.putEvents(events);
      await store.putSession({
        session_uuid: p.sessionUuid, file_path: file.path, repo_key: shardKey,
        project_dir: file.projectDir, tier: file.tier, source: file.source,
        cwd: p.cwd ?? "", model: p.model ?? "", worktree: ctx.worktree,
        workflow_run_id: file.workflowRunId ?? "", agent_id: file.agentId ?? "",
        file_mtime: file.mtime, file_size: file.size,
        line_count: p.lines, event_count: kept.length, bad_lines: p.badLines,
        started_at: p.startedAt ?? "", ended_at: p.endedAt ?? "",
        description: p.description ?? "", imported_at: nowISO(),
      });
      await store.putFile({ file_path: file.path, repo_key: shardKey, mtime: file.mtime, size: file.size, imported_at: nowISO() });
      man.set(file.path, { mtime: file.mtime, size: file.size });
      added += events.length;
      imported++;
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

  for (const key of shards.keys()) {
    try { await (await shards.get(key === "_unresolved" ? null : key)).ensureFtsIndex(); } catch {}
  }
  return { added, skipped, failed, filtered, skippedNoise, done, imported, shards };
}
