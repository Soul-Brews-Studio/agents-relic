import { LanceStore } from "./store/lance.js";
import { listShards } from "./repo.js";
import { progress } from "./progress.js";

export interface FtsRebuild {
  shards: number;                          // on disk, every bank
  rebuilt: number;
  drifted: number;                         // of those, built with other stop-word settings (#97)
  empty: number;                           // no `events` table, so nothing to index
  kept: number;                            // an ICU index this LanceDB build cannot rewrite
  failed: { key: string; err: string }[];
  simple: string[];                        // "bank/repo" rebuilt with `simple`: this build has no ICU
  noIcu: string;                           // the error that refused ICU
  ms: number;
}

/**
 * `relic index --fts-rebuild`: rebuild the full-text index of EVERY shard on disk.
 *
 * An import only reaches the shards its discovery opens. A shard whose source is disabled
 * or gone, or narrowed away by --since or --repo, keeps the index it was built with — and
 * keeps it silently, because a stale index still answers. #97 is that shape: the stop-word
 * setting that dropped `nas` is baked into every shard built before the fix, and fixing
 * ftsConfig() reaches only the shards a later run happens to open. So this walks
 * listShards() — the directory tree, every bank — not discovery, and rebuilds
 * unconditionally: an index that cannot say how it was built is rebuilt too.
 */
export async function rebuildFts(o: { dataRoot: string | null; inRepo: boolean; progress?: boolean }): Promise<FtsRebuild> {
  const t0 = Date.now();
  const all = listShards(o.dataRoot, o.inRepo);
  const out: FtsRebuild = { shards: all.length, rebuilt: 0, drifted: 0, empty: 0, kept: 0,
                            failed: [], simple: [], noIcu: "", ms: 0 };
  const bar = progress();
  for (let i = 0; i < all.length; i++) {
    if (o.progress) bar.tick(`  rebuilding full-text index  ${i + 1}/${all.length} shards   `,
                             ((i + 1) / all.length) * 100, i === all.length - 1);
    try {
      const r = await (await LanceStore.open(all[i].dir)).ensureFtsIndex({ rebuild: true });
      if (!r) { out.empty++; continue; }
      if (r.fellBack) out.noIcu ||= r.fellBack;
      if (!r.built) { out.kept++; continue; }
      out.rebuilt++;
      if (r.drifted) out.drifted++;
      if (r.tokenizer === "simple") out.simple.push(all[i].key);
    } catch (err) {
      out.failed.push({ key: all[i].key, err: String(err).slice(0, 160) });
    }
  }
  if (o.progress) bar.clear();
  out.ms = Date.now() - t0;
  return out;
}
