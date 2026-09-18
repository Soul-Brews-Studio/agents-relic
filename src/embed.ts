import { LanceStore, type VectorRow } from "./store/lance.js";
import { pickShards, type Scope } from "./query.js";

/**
 * Embedding the index — the WRITE half only.
 *
 * `index` does not call anything here, and that separation is the feature. Embedding is
 * expensive, optional, and was measured to LOSE to the full-text index on this corpus
 * (FTS 0.890 MRR@20 against 0.600 for the best of three models — see bench/README.md).
 * So it is a second pass over an index that is already complete and already answers:
 * "index first, embed later", with later meaning "if at all".
 *
 * Everything written lands in the per-shard `vectors` table, never on `events`. See the
 * VectorRow comment in store/lance.ts for the measurement behind that.
 */

// --------------------------------------------------------------------- providers

export interface EmbedProvider {
  /** Provider-qualified, and this string is what goes on disk in VectorRow.model. */
  id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export const DEFAULT_OLLAMA = "http://localhost:11434";

/**
 * Ollama over HTTP. Chosen as the default because it needs NOTHING added to this
 * repo — no Python, no torch, no model download step inside the tool — and because
 * both the TypeScript and the Python implementation can speak it identically, which
 * keeps `relic embed` and `relic-py embed` the same command rather than two.
 *
 * Models measured locally, 2026-09-18, dim read off the live response:
 *
 *   all-minilm             384   en only   — cos(en, th-translation) +0.187
 *   nomic-embed-text       768             — +0.467
 *   mxbai-embed-large     1024             — +0.479
 *   qwen3-embedding:0.6b  1024   multi     — +0.572
 *   bge-m3                1024   multi     — +0.626
 *
 * That cosine is a SMOKE TEST, not a benchmark: one English string against its Thai
 * translation, which says whether a model places the two languages in one space at
 * all. It says nothing about ranking quality. `all-minilm` at +0.187 is the honest
 * shape of "English-only" — pick it for 384 dims on an English corpus, not for this
 * one, which is en+th.
 */
export function ollamaProvider(model: string, host = DEFAULT_OLLAMA): EmbedProvider {
  return {
    id: `ollama:${model}`,
    async embed(texts) {
      const res = await fetch(`${host.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json() as { embeddings?: number[][]; error?: string };
      if (j.error) throw new Error(`ollama: ${j.error}`);
      if (!j.embeddings?.length) throw new Error(`ollama returned no embeddings for ${texts.length} inputs`);
      // A short batch back is worse than an error: the rows would pair to the wrong
      // uids and every vector in the batch would be silently mislabelled.
      if (j.embeddings.length !== texts.length)
        throw new Error(`ollama returned ${j.embeddings.length} vectors for ${texts.length} inputs`);
      return j.embeddings;
    },
  };
}

export function providerFor(name: string, model: string, host?: string): EmbedProvider {
  if (name === "ollama") return ollamaProvider(model, host);
  throw new Error(
    `unknown provider "${name}". TypeScript speaks "ollama" only — it has no model runtime ` +
    `and adding one would mean a torch-sized dependency in a 3-dependency tool. For ` +
    `sentence-transformers (e.g. intfloat/multilingual-e5-small, 384 dims, multilingual), ` +
    `use the Python implementation: relic-py embed --provider st --model <name>`);
}

// ----------------------------------------------------------------------- helpers

/**
 * L2-normalise, so that LanceDB's default L2 distance ranks identically to cosine.
 *
 * Doing it on WRITE rather than at query time means the choice is recorded on disk
 * (VectorRow.norm) instead of living in whichever caller happens to run the search.
 * A zero vector is left alone rather than divided by zero — it can only come from a
 * provider failure, and NaNs would poison every later comparison silently.
 */
export function l2normalise(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const n = Math.sqrt(sum);
  return n > 0 ? v.map(x => x / n) : v;
}

export interface EmbedOpts extends Scope {
  provider?: string;      // "ollama"
  model?: string;
  host?: string;
  batch?: number;
  limit?: number;         // cap per shard, not total — makes a smoke test cheap
  mainTiers?: boolean;
  minChars?: number;
  maxChars?: number;
  dryRun?: boolean;
  reset?: boolean;        // drop `vectors` first — the only way to change model/dim
  onProgress?: (p: { shard: string; done: number; pending: number }) => void;
}

export interface ShardEmbedStat {
  key: string; bank: string; repo: string;
  eligible: number;      // events that pass the tier/length filter
  already: number;       // of those, already embedded
  pending: number;       // what this run would do (before --limit)
  embedded: number;      // what it actually did
  failed: number;
  model: string; dim: number;
  skipped?: string;      // why this shard was left alone
}

export interface EmbedTally {
  shards: ShardEmbedStat[];
  embedded: number; failed: number; pending: number;
  ms: number; dryRun: boolean; providerId: string;
}

// -------------------------------------------------------------------- the driver

/**
 * One shard. Resumable by construction: the anti-join is against what is ON DISK, so
 * an interrupted run is re-entered by simply running the command again.
 */
export async function embedShard(
  store: LanceStore, p: EmbedProvider, o: EmbedOpts,
): Promise<{ eligible: number; already: number; pending: number; embedded: number; failed: number; dim: number; skipped?: string }> {
  const minChars = o.minChars ?? 24;
  const maxChars = o.maxChars ?? 2000;
  const batch = Math.max(1, o.batch ?? 64);
  const mainTiers = o.mainTiers !== false;

  const eligible = await store.embeddableCount({ mainTiers, minChars });
  // --reset before the stats read, so the mismatch guard below sees the post-drop state
  // rather than refusing on vectors this run is about to discard anyway.
  if (o.reset && !o.dryRun) await store.dropVectors();
  const prior = await store.vectorStats();
  const already = prior?.rows ?? 0;

  /*
   * A FixedSizeList has ONE width. Writing a 1024-dim vector into a table created at
   * 384 fails mid-batch, after an arbitrary amount of work has already landed — so the
   * mismatch is caught here, before the first HTTP call, and the shard is skipped with
   * a reason rather than half-written. Changing model is a delete-and-rerun, and saying
   * so is cheaper than discovering it 40 minutes in.
   */
  if (prior && prior.rows > 0 && prior.model && prior.model !== p.id) {
    return { eligible, already, pending: 0, embedded: 0, failed: 0, dim: prior.dim,
             skipped: `holds ${prior.rows} vectors from ${prior.model} (dim ${prior.dim}); ` +
                      `re-embed with ${p.id} by adding --reset (drops this shard's vectors table only)` };
  }

  const todo = await store.unembedded({ limit: o.limit, mainTiers, minChars });
  if (o.dryRun || !todo.length)
    return { eligible, already, pending: todo.length, embedded: 0, failed: 0, dim: prior?.dim ?? 0 };

  let embedded = 0, failed = 0, dim = prior?.dim ?? 0;
  for (let i = 0; i < todo.length; i += batch) {
    const slice = todo.slice(i, i + batch);
    try {
      const vecs = await p.embed(slice.map(x => x.text.slice(0, maxChars)));
      const at = new Date().toISOString();
      const rows: VectorRow[] = slice.map((x, j) => ({
        uid: x.uid, embedding: l2normalise(vecs[j]), model: p.id,
        dim: vecs[j].length, norm: "l2", embedded_at: at,
      }));
      // Every row in one table must share a width; a provider that changes its mind
      // mid-run would otherwise corrupt the shard one batch at a time.
      const widths = new Set(rows.map(r => r.dim));
      if (widths.size !== 1) throw new Error(`provider returned mixed dims: ${[...widths].join(", ")}`);
      if (dim && rows[0].dim !== dim) throw new Error(`dim changed mid-run: ${dim} -> ${rows[0].dim}`);
      dim = rows[0].dim;
      await store.putVectors(rows);
      embedded += rows.length;
    } catch {
      // One bad batch must not end a backfill that is resumable anyway — the uids in
      // it simply stay pending and the next run picks them up.
      failed += slice.length;
    }
    o.onProgress?.({ shard: "", done: embedded, pending: todo.length });
  }
  return { eligible, already, pending: todo.length, embedded, failed, dim };
}

export async function embedShards(o: EmbedOpts = {}): Promise<EmbedTally> {
  const t0 = Date.now();
  const p = providerFor(o.provider ?? "ollama", o.model ?? "all-minilm", o.host);
  const shards = pickShards(o);
  const out: ShardEmbedStat[] = [];
  let embedded = 0, failed = 0, pending = 0;

  for (const sh of shards) {
    try {
      const store = await LanceStore.open(sh.dir);
      const r = await embedShard(store, p, {
        ...o, onProgress: x => o.onProgress?.({ ...x, shard: sh.key }),
      });
      out.push({ key: sh.key, bank: sh.bank, repo: sh.repo, model: p.id, ...r });
      embedded += r.embedded; failed += r.failed; pending += r.pending;
    } catch (err) {
      out.push({ key: sh.key, bank: sh.bank, repo: sh.repo, eligible: 0, already: 0,
                 pending: 0, embedded: 0, failed: 0, model: p.id, dim: 0,
                 skipped: String(err).slice(0, 160) });
    }
  }
  return { shards: out, embedded, failed, pending, ms: Date.now() - t0,
           dryRun: Boolean(o.dryRun), providerId: p.id };
}
