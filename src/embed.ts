import { LanceStore, type VectorRow, type VectorDamage } from "./store/lance.js";
import { pickShards, type Scope } from "./query.js";
import { checkEmbedModel, type EmbedCheck } from "./langs.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  /** Release a long-lived child process. Absent for providers that hold nothing. */
  close?(): void;
}

export const DEFAULT_OLLAMA = "http://localhost:11434";
/** embed's default: the best vector model bench/ measured on this corpus, with its prompts (#101). */
export const DEFAULT_MODEL = "embeddinggemma";

export interface MeasuredModel {
  provider: "ollama" | "st";
  model: string;            // exactly what --model takes
  dim: number;
  multilingual: boolean;    // marked "multi" when measured — unmarked is NOT a claim of Thai support
  enTh?: number;            // cos(en, th-translation), the smoke test below
  knownItem?: { all: number; th: number };   // MRR@20, bench/README.md
  paraphrase?: { all: number; th: number };  // MRR@20, bench/README.md
}

/**
 * Every model measured on THIS corpus, and the numbers — kept as data in one place so
 * `relic langs` recommends from the same figures the comments here argue from.
 *
 * `enTh`: Ollama models measured locally 2026-09-18, dim read off the live response.
 * One English string against its Thai translation — a SMOKE TEST, not a benchmark. It
 * says whether a model places the two languages in one space at all, and nothing about
 * ranking quality.
 *
 * `knownItem` / `paraphrase`: bench/ (3,000 docs, 400 with Thai, 200 queries each). The
 * ranking numbers, for the three sentence-transformers models. FTS scored 0.890 (Thai
 * 0.768) on known-item there, above every model below. `embeddinggemma`'s come from the
 * second pool (#122, drawn from all banks, where FTS scored 0.941), so they place it
 * against the others roughly, not to the third decimal.
 */
export const MEASURED_MODELS: MeasuredModel[] = [
  { provider: "ollama", model: "all-minilm", dim: 384, multilingual: false, enTh: 0.187 },
  { provider: "ollama", model: "nomic-embed-text", dim: 768, multilingual: false, enTh: 0.467 },
  { provider: "ollama", model: "mxbai-embed-large", dim: 1024, multilingual: false, enTh: 0.479 },
  { provider: "ollama", model: "qwen3-embedding:0.6b", dim: 1024, multilingual: true, enTh: 0.572 },
  { provider: "ollama", model: "bge-m3", dim: 1024, multilingual: true, enTh: 0.626 },
  // With OLLAMA_PROMPTS on both sides; raw text scores 0.557 / 0.170. `th` is the Thai
  // share of each set; the Thai-only known-item set (200 targets) scored 0.476.
  { provider: "ollama", model: "embeddinggemma", dim: 768, multilingual: true,
    knownItem: { all: 0.646, th: 0.398 }, paraphrase: { all: 0.318, th: 0.398 } },
  { provider: "st", model: "intfloat/multilingual-e5-small", dim: 384, multilingual: true,
    knownItem: { all: 0.600, th: 0.308 }, paraphrase: { all: 0.140, th: 0.214 } },
  { provider: "st", model: "sentence-transformers/all-MiniLM-L6-v2", dim: 384, multilingual: false,
    knownItem: { all: 0.503, th: 0.209 }, paraphrase: { all: 0.119, th: 0.006 } },
  { provider: "st", model: "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", dim: 384, multilingual: true,
    knownItem: { all: 0.430, th: 0.203 }, paraphrase: { all: 0.081, th: 0.078 } },
];

/**
 * Model-card prompts, for the Ollama models that want them. Ollama's /api/embed sends
 * text as given, so a model trained with a task prompt gets raw text unless the caller
 * adds it — and embeddinggemma without its prompts falls from 0.318 to 0.170 paraphrase
 * MRR, back among the models it otherwise beats (bench/README.md, #122).
 *
 * Asymmetric like e5: `doc` goes on everything embed writes, `query` on the search
 * string. Keyed by model name without its Ollama tag, so `embeddinggemma:300m` matches.
 * A model with no entry is sent raw text, as it always was.
 */
export const OLLAMA_PROMPTS: Record<string, { doc: string; query: string }> = {
  embeddinggemma: { doc: "title: none | text: ", query: "task: search result | query: " },
};

export function ollamaPrompts(model: string): { doc: string; query: string } | undefined {
  return OLLAMA_PROMPTS[model.replace(/:[^:/]*$/, "")];
}

/**
 * Ollama over HTTP. Chosen as the default because it needs NOTHING added to this
 * repo — no Python, no torch, no model download step inside the tool — and because
 * both the TypeScript and the Python implementation can speak it identically, which
 * keeps `relic embed` and `relic-py embed` the same command rather than two.
 *
 * The models measured for it, with their cos(en, th-translation), are MEASURED_MODELS
 * above. `all-minilm` at +0.187 is the honest shape of "English-only" — pick it for
 * 384 dims on an English corpus, not for this one, which is en+th. `relic langs`
 * measures how en+th it actually is.
 */
export function ollamaProvider(model: string, host = DEFAULT_OLLAMA, prefix?: string): EmbedProvider {
  // The document prompt from OLLAMA_PROMPTS unless a caller names one: queryProviderFor
  // passes the query prompt, or "" for a shard written raw. Recorded in the id as st does.
  const pre = prefix ?? ollamaPrompts(model)?.doc ?? "";
  return {
    id: `ollama:${model}` + (pre ? `+${pre.trim()}` : ""),
    async embed(texts) {
      const res = await fetch(`${host.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: pre ? texts.map(t => pre + t) : texts }),
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

/**
 * sentence-transformers, reached through the Python sidecar rather than a port.
 *
 * TypeScript has no model runtime and adding one means a torch-sized dependency in a
 * three-dependency tool. But refusing the provider outright made `relic embed` and
 * `relic-py embed` two different commands, which is the thing this codebase spends the
 * most effort not being. So the model stays in Python, where it already is, and the
 * TypeScript side spawns `relicpy.embed_server` and talks JSON-lines to it.
 *
 * One PERSISTENT process, not one per batch: loading e5-small costs ~10 s and a backfill
 * is thousands of batches.
 *
 * `uv run --with sentence-transformers` is the launcher, so nothing is installed into
 * the repo's own environment — the dependency exists for the life of the process.
 */
export function stProvider(model: string, opts: { device?: string; pythonRoot?: string; prefix?: string } = {}): EmbedProvider {
  // e5 models want asymmetric prefixes ("passage: " on documents, "query: " on queries).
  // Getting it wrong costs recall silently, so it is inferred here AND recorded in the
  // provider id, which lands on disk beside every vector.
  const docPrefix = opts.prefix ?? (/e5/i.test(model) ? "passage: " : "");
  const root = opts.pythonRoot
    ?? join(dirname(fileURLToPath(import.meta.url)), "..", "python");
  const args = ["run", "--with", "sentence-transformers", "python", "-m",
                "relicpy.embed_server", "--model", model];
  if (opts.device) args.push("--device", opts.device);
  if (docPrefix) args.push("--doc-prefix", docPrefix);

  let proc: ReturnType<typeof Bun.spawn> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let buf = "";

  /** Read exactly one protocol line, buffering whatever else arrives with it. */
  async function line(): Promise<Record<string, unknown>> {
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const raw = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (raw.trim()) return JSON.parse(raw);
        continue;
      }
      const { done, value } = await reader!.read();
      // EOF mid-protocol means the child died — usually the model failed to load. The
      // child's stderr is inherited, so the real reason is already on the terminal.
      if (done) throw new Error("embed_server exited before answering (see stderr above)");
      buf += new TextDecoder().decode(value);
    }
  }

  async function start(): Promise<void> {
    if (proc) return;
    proc = Bun.spawn(["uv", ...args], {
      cwd: root, stdin: "pipe", stdout: "pipe",
      stderr: "inherit",   // progress bars and HF warnings must NEVER reach the protocol
    });
    reader = proc.stdout.getReader();
    const hello = await line();
    if (hello.error) throw new Error(String(hello.error));
    if (!hello.ready) throw new Error(`embed_server sent no handshake: ${JSON.stringify(hello).slice(0, 160)}`);
  }

  return {
    id: `st:${model}` + (docPrefix ? `+${docPrefix.trim()}` : ""),
    async embed(texts) {
      await start();
      proc!.stdin.write(JSON.stringify({ texts }) + "\n");
      await proc!.stdin.flush();
      const r = await line();
      if (r.error) throw new Error(String(r.error));
      const vecs = r.embeddings as number[][];
      if (!vecs?.length) throw new Error("embed_server returned no embeddings");
      // Same guard as the HTTP provider: a short batch would pair rows to the wrong uids.
      if (vecs.length !== texts.length)
        throw new Error(`embed_server returned ${vecs.length} vectors for ${texts.length} inputs`);
      return vecs;
    },
    close() { try { proc?.stdin.end(); proc?.kill(); } catch { /* already gone */ } },
  };
}

/**
 * Rebuild a provider from the id a shard STORED, for embedding a query.
 *
 * The writer's id is on disk beside every vector (`ollama:all-minilm`,
 * `st:intfloat/multilingual-e5-small+passage:`) and it is the only trustworthy record
 * of how those vectors were made. Re-deriving the model from a flag would let a query
 * be embedded by a different model than the documents, which produces confident
 * nonsense rather than an error: both sides are 384-dim floats and the distance
 * computes fine.
 *
 * ASYMMETRIC PREFIXES ARE THE TRAP. e5 wants "passage: " on documents and "query: " on
 * queries; using the document prefix for a query costs recall silently. So the stored
 * `+passage:` suffix is read as "this family is asymmetric" and the QUERY side is built
 * with "query: " instead. Ollama's `+title: none | text:` is looked up in OLLAMA_PROMPTS
 * the same way, and its entry's query prompt is used.
 */
export function queryProviderFor(storedId: string, device?: string): EmbedProvider {
  const m = /^([^:]+):(.*)$/.exec(storedId);
  if (!m) throw new Error(`unreadable stored model id: ${JSON.stringify(storedId)}`);
  const [, kind, rest] = m;
  const plus = rest.lastIndexOf("+");
  const model = plus >= 0 ? rest.slice(0, plus) : rest;
  const docPrefix = plus >= 0 ? rest.slice(plus + 1) : "";
  if (kind === "ollama") {
    // No suffix is a shard written raw — before OLLAMA_PROMPTS, or for a model without
    // an entry — so its queries go raw too, even for a model that now has prompts.
    if (!docPrefix) return ollamaProvider(model, DEFAULT_OLLAMA, "");
    const p = ollamaPrompts(model);
    if (!p || p.doc.trim() !== docPrefix)
      throw new Error(`no query prompt known for ${JSON.stringify(storedId)}: OLLAMA_PROMPTS ` +
                      `has ${p ? JSON.stringify(p.doc.trim()) : "no entry"} for ${model}`);
    return ollamaProvider(model, DEFAULT_OLLAMA, p.query);
  }
  if (kind === "st")
    return stProvider(model, { device, prefix: docPrefix === "passage:" ? "query: " : "" });
  throw new Error(`unknown stored provider "${kind}" in ${JSON.stringify(storedId)}`);
}

export function providerFor(name: string, model: string, host?: string,
                            device?: string): EmbedProvider {
  if (name === "ollama") return ollamaProvider(model, host);
  if (name === "st") return stProvider(model, { device });
  throw new Error(`unknown provider "${name}" — expected "ollama" or "st"`);
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
  device?: string;       // st only: cpu | mps | cuda
  batch?: number;
  limit?: number;         // cap per shard, not total — makes a smoke test cheap
  mainTiers?: boolean;
  minChars?: number;
  maxChars?: number;
  dryRun?: boolean;
  session?: string;       // embed ONE session — the /forward + /new unit
  reset?: boolean;        // drop `vectors` first — the only way to change model/dim
  force?: boolean;        // embed with an English-only model on a scope that is not — see checkEmbedModel
  scopeArgs?: string[];   // the flags that set this scope, echoed into the commands the check prints
  onCheck?: (c: EmbedCheck) => void;   // once, after the language check and before any provider call
  onCheckProgress?: (done: number, total: number, key: string) => void;   // per shard the check samples
  repair?: boolean;       // restore (or, failing that, drop) a `vectors` table that no longer reads — #105
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
  damage?: VectorDamage;             // `vectors` failed to read — see LanceStore.vectorDamage()
  repaired?: "restored" | "dropped"; // what --repair did about it
}

type ShardResult = Omit<ShardEmbedStat, "key" | "bank" | "repo" | "model">;

const fmtN = (n: number) => n.toLocaleString("en-US");
const quote = (a: string) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;

/** The Lance error, without the "Error: ... stream:" wrapper or the rustc source location. */
function lanceReason(error: string): string {
  return /LanceError\([^)]*\): [^,\n]*/.exec(error)?.[0] ?? error.replace(/^Error: /, "").slice(0, 120);
}

/**
 * What to say under a shard whose `vectors` table failed to read (#105).
 *
 * Unrepaired: what is safe, and the ONE command that repairs this shard and nothing
 * else. `carry` is the caller's own flags minus scope, which the command replaces.
 * Provider and model have to ride along, because after the repair the same run carries
 * on embedding, and a different model would only meet the mismatch guard. --data-root
 * has to ride along too: a command that dropped it would act on the live index instead
 * of the one that was read. --repair can only ever restore or drop a table that fails to
 * read, so even if `--repo` matches as a substring, no healthy table is touched.
 *
 * Repaired: what was done, and what it kept.
 */
export function damageNote(sh: ShardEmbedStat, carry: string[], program = "relic"): string[] {
  const d = sh.damage;
  if (!d) return [];
  if (sh.repaired === "restored")
    return [`repaired: restored v${d.restorable} of \`vectors\`, keeping ${fmtN(d.keep)} of ${fmtN(d.rows)} rows; v${d.version} did not read`];
  if (sh.repaired === "dropped")
    return [`repaired: dropped \`vectors\` — no version of it read — so this run embeds the shard from scratch`];
  const cmd = [program, "embed", "--repair", "--bank", sh.bank, "--repo", sh.repo, ...carry].map(quote).join(" ");
  return [
    `\`events\` and the full-text index are untouched. To repair this shard's vectors only:`,
    `  ${cmd}`,
    d.restorable === null
      ? `no version of the table reads, so that drops it and re-embeds the shard`
      : `that restores v${d.restorable} (${fmtN(d.keep)} of ${fmtN(d.rows)} vectors) and re-embeds the rest`,
  ];
}

export interface EmbedTally {
  shards: ShardEmbedStat[];
  embedded: number; failed: number; pending: number;
  ms: number; dryRun: boolean; providerId: string;
  check: EmbedCheck;      // the scope's languages against the model, measured before anything else
  refused: boolean;       // the check stopped this run before the embed pass: no provider called
}

// -------------------------------------------------------------------- the driver

/**
 * One shard. Resumable by construction: the anti-join is against what is ON DISK, so
 * an interrupted run is re-entered by simply running the command again.
 */
export async function embedShard(store: LanceStore, p: EmbedProvider, o: EmbedOpts): Promise<ShardResult> {
  const minChars = o.minChars ?? 24;
  const maxChars = o.maxChars ?? 2000;
  const batch = Math.max(1, o.batch ?? 64);
  const mainTiers = o.mainTiers !== false;

  const eligible = await store.embeddableCount({ mainTiers, minChars, session: o.session });
  // --reset before the stats read, so the mismatch guard below sees the post-drop state
  // rather than refusing on vectors this run is about to discard anyway.
  if (o.reset && !o.dryRun) await store.dropVectors();

  let prior: Awaited<ReturnType<LanceStore["vectorStats"]>>;
  let todo: { uid: string; text: string }[];
  try {
    prior = await store.vectorStats();
    /*
     * A FixedSizeList has ONE width. Writing a 1024-dim vector into a table created at
     * 384 fails mid-batch, after an arbitrary amount of work has already landed — so the
     * mismatch is caught here, before the first HTTP call, and the shard is skipped with
     * a reason rather than half-written. Changing model is a delete-and-rerun, and saying
     * so is cheaper than discovering it 40 minutes in.
     */
    if (prior && prior.rows > 0 && prior.model && prior.model !== p.id) {
      return { eligible, already: prior.rows, pending: 0, embedded: 0, failed: 0, dim: prior.dim,
               skipped: `holds ${prior.rows} vectors from ${prior.model} (dim ${prior.dim}); ` +
                        `re-embed with ${p.id} by adding --reset (drops this shard's vectors table only)` };
    }
    todo = await store.unembedded({ limit: o.limit, mainTiers, minChars, session: o.session });
  } catch (err) {
    /*
     * A VECTORS TABLE THAT NO LONGER READS (#105).
     *
     * The anti-join is the first read to touch every row of `vectors`, so this is where
     * the damage shows. It used to show as a bare SKIP carrying a Lance IO error. That
     * repeated on every run, and the only way out was `rm -rf .../vectors.lance`: a full
     * re-embed, which took 262 s for 1.4k events and would take hours at 3M.
     *
     * The diagnosis runs only after a read has failed, so a healthy shard pays nothing
     * for it. If `vectors` still reads, the failure came from somewhere else (`events`,
     * say) and is rethrown unchanged, so nothing is dropped on a guess. Without --repair,
     * the shard is skipped with the damage attached, and the caller prints the one
     * command that repairs this shard. A dry run never repairs.
     */
    const damage = await store.vectorDamage();
    if (!damage) throw err;
    if (!o.repair || o.dryRun)
      return { eligible, already: 0, pending: 0, embedded: 0, failed: 0, dim: 0, damage,
               skipped: `vectors table unreadable at v${damage.version} — ${lanceReason(damage.error)}` };
    const repaired = await store.repairVectors(damage);
    // Start over on the repaired table, so the counts, the model guard and the anti-join
    // all read it fresh. With repair off, a table that still fails is reported, not
    // repaired in a loop.
    return { ...(await embedShard(store, p, { ...o, repair: false, reset: false })), damage, repaired };
  }
  const already = prior?.rows ?? 0;

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

/** `p` comes from the flags unless a caller hands one in, which is how the tests run offline. */
export async function embedShards(
  o: EmbedOpts = {},
  p: EmbedProvider = providerFor(o.provider ?? "ollama", o.model ?? DEFAULT_MODEL, o.host, o.device),
): Promise<EmbedTally> {
  const t0 = Date.now();
  // The scope's languages against the model, BEFORE any provider call: the population is
  // the one embedShard reads below, sampled 1 in 64 by uid.
  const check = await checkEmbedModel(p.id, {
    dataRoot: o.dataRoot, inRepo: o.inRepo, repo: o.repo, bank: o.bank, session: o.session,
    mainTiers: o.mainTiers !== false, minChars: o.minChars ?? 24, maxChars: o.maxChars ?? 2000,
    scopeArgs: o.scopeArgs, force: o.force, onProgress: o.onCheckProgress,
  });
  o.onCheck?.(check);
  // A dry run reports the refusal and still counts: it writes nothing and calls no provider.
  const refused = check.action === "refuse" && !o.dryRun;
  const shards = refused ? [] : pickShards(o);
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
  // A sidecar outlives the loop unless it is told not to — an orphaned python holding a
  // model is 500 MB of RSS that never comes back.
  p.close?.();
  return { shards: out, embedded, failed, pending, ms: Date.now() - t0,
           dryRun: Boolean(o.dryRun), providerId: p.id, check, refused };
}
