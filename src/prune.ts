import { splitShardKey, type ImportTally } from "./import.js";
import { listShards } from "./repo.js";

/**
 * Removing rows the index should no longer hold.
 *
 * The importer only ever adds and updates. A file that stops being discoverable — a
 * new skip rule excluded it, it was deleted, it moved — keeps its `events`, `sessions`
 * and `files` rows forever. Measured on the live index before this existed: 1,353
 * `journal.jsonl` rows for a file discovery has skipped since 2026-09-18, which made
 * EVERY session tree containing a workflow report one transcript too many. Two
 * resolvers were taught to filter journal.jsonl out rather than fix this — two
 * workarounds for one absent feature.
 *
 * THIS IS THE ONLY CODE IN RELIC THAT DELETES ROWS A HUMAN DID NOT NAME, so the whole
 * design is the scoping. The naive version — "drop rows whose file_path was not seen
 * this run" — destroys the index on any normal invocation, because a narrowed scan is
 * the normal case: `--since 7d` cannot see a file older than seven days, and `--repo`
 * never parses most of the corpus at all.
 *
 * Four gates, from widest to narrowest:
 *
 *   1. the run must be UNFILTERED — no --since, no --repo
 *   2. nothing may have FAILED to parse; a file that failed is not a file that is gone
 *   3. only shards this run actually reached are considered — a bank whose source was
 *      not in --corpus, or whose root was missing, is never touched
 *   4. a shard losing more than `maxDropPct` of its files is REFUSED, not pruned
 *
 * Gate 4 is not paranoia, it is a bug that already happened. `ghq.root` was unset on
 * white.local, so `resolveRepoKey` returned null for everything and every file
 * resolved to `_unresolved` — under gates 1-3 alone that reads as "every real shard
 * lost all its files" and prunes the entire index while printing a clean summary.
 */

export interface PruneOpts {
  apply: boolean;
  /** Refuse any shard that would lose more than this share of its files. */
  maxDropPct: number;
  force: boolean;
  dataRoot: string | null;
  inRepo: boolean;
  /** The run's own narrowing — gate 1 reads these, it does not re-derive them. */
  sinceMs: number | null;
  repoFilter: string | null;
}

export interface ShardPrune {
  shardKey: string; bank: string; repo: string;
  indexed: number; discovered: number;
  drop: string[];
  dropPct: number;
  blocked: string | null;
  removed: { events: number; sessions: number; files: number; vectors: number } | null;
}

export interface PrunePlan {
  /** null when the run itself was ineligible — nothing below was even looked at. */
  refused: string | null;
  shards: ShardPrune[];
  /** Shards on disk this run never reached. Not a failure — the conservative case. */
  untouched: number;
  applied: boolean;
}

export const DEFAULT_MAX_DROP_PCT = 10;

/** Why this run may not prune, or null. */
export function pruneRefusal(t: ImportTally, o: Pick<PruneOpts, "sinceMs" | "repoFilter">): string | null {
  if (o.sinceMs !== null)
    return "--since narrows discovery to recent files, so every older file would look deleted. Prune needs a full scan.";
  if (o.repoFilter)
    return "--repo narrows discovery to one repo, so every other repo would look deleted. Prune needs a full scan.";
  if (t.failed)
    return `${t.failed.toLocaleString("en-US")} file${t.failed === 1 ? "" : "s"} failed to parse. ` +
           `A file that failed to parse is not a file that is gone — re-run with --verbose, fix it, then prune.`;
  return null;
}

/**
 * Compare discovery against the index and, if `apply`, remove the difference.
 *
 * The dry run and the real run are the SAME call with a flag, down into
 * `LanceStore.pruneFiles` — so the count a human approved is produced by the code that
 * executes, not by a second query that resembles it.
 */
export async function prune(t: ImportTally, o: PruneOpts): Promise<PrunePlan> {
  const refused = pruneRefusal(t, o);
  if (refused) return { refused, shards: [], untouched: 0, applied: false };

  const out: ShardPrune[] = [];
  for (const [shardKey, discovered] of t.seen) {
    const store = t.shards.byKey(shardKey);
    if (!store) continue;                      // cannot happen: seen is filled beside the pool
    const { bank, repo } = splitShardKey(shardKey);
    const indexed = await store.indexedFiles();
    const drop = [...indexed].filter(p => !discovered.has(p)).sort();
    const dropPct = indexed.size ? (drop.length / indexed.size) * 100 : 0;

    let blocked: string | null = null;
    if (drop.length && dropPct > o.maxDropPct && !o.force)
      blocked = `would drop ${dropPct.toFixed(1)}% of this shard (ceiling ${o.maxDropPct}%)`;

    const removed = drop.length && !blocked ? await store.pruneFiles(drop, o.apply) : null;
    out.push({ shardKey, bank, repo, indexed: indexed.size, discovered: discovered.size,
               drop, dropPct, blocked, removed });
  }

  // Shards on disk this run never reached. Reported because "nothing to prune" and
  // "never looked" are different facts, and only one of them means the index is clean.
  const onDisk = listShards(o.dataRoot, o.inRepo);
  const reached = new Set(t.seen.keys());
  const untouched = onDisk.filter(s => !reached.has(`${s.bank}\u0000${s.repo}`)).length;

  return { refused: null, shards: out, untouched, applied: o.apply };
}

/** Totals across a plan — the numbers a summary line quotes. */
export function pruneTotals(plan: PrunePlan) {
  let files = 0, events = 0, sessions = 0, vectors = 0, shards = 0, blocked = 0;
  for (const s of plan.shards) {
    if (s.blocked) { blocked++; continue; }
    if (!s.drop.length) continue;
    shards++;
    files += s.drop.length;
    events += s.removed?.events ?? 0;
    sessions += s.removed?.sessions ?? 0;
    vectors += s.removed?.vectors ?? 0;
  }
  return { files, events, sessions, vectors, shards, blocked };
}
