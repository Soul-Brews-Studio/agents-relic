import { createReadStream, statSync } from "node:fs";
import { isHostPreamble, stripEnvelope, viaLabel, parseChannelEnvelope, type ChannelFacets } from "./types.js";
import { localDateTime, zoneOffset } from "./time.js";
export { isHostPreamble };
import os from "node:os";
import { createInterface } from "node:readline";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { queryProviderFor } from "./embed.js";
import { discover, parseSince } from "./discover.js";
import { resolveRepoKey, listShards, repoKeyOf } from "./repo.js";
import { seekOnDisk } from "./seek.js";
import { walkFailures, type WalkFailure } from "./unreadable.js";
import { importFiles } from "./import.js";
import { buildChain, type Chain, type ChainRow } from "./chain.js";
import { treeFiles } from "./live.js";

/**
 * Reading from the index — every lookup relic can do, as functions that return DATA.
 *
 * Both front ends call this: the CLI renders the result for a human, the MCP server
 * serialises it for a model. Neither reimplements a query. When the same lookup exists
 * twice it drifts, and the version the model gets is the one nobody runs by hand.
 *
 * Nothing here prints or exits. A caller decides what a miss looks like.
 */

export interface Scope {
  dataRoot?: string | null;
  inRepo?: boolean;
  repo?: string;        // substring of the REPO portion only, e.g. "neo-oracle"
  bank?: string;        // exact bank name, e.g. "projects-archive" — see repo.ts
}

export interface SearchOpts extends Scope {
  limit?: number;
  tier?: string; source?: string; worktree?: string; path?: string; role?: string;
  org?: string; project?: string; dir?: string; memType?: string;
  /**
   * Include subagent and workflow_agent transcripts. Default FALSE — see searchEvents.
   */
  allTiers?: boolean;
  since?: string; until?: string;   // 7d / 12h / 30m / 2026-09-01 / full ISO
  prose?: boolean;
  /** Channel facets, each a case-blind substring: the front door, the room, the sender. */
  via?: string; chat?: string; fromUser?: string;
  /**
   * Run the generic-query heuristic (see checkGenericQuery). Default true — the
   * check is cheap relative to the search it rides along with, so opting OUT is the
   * flag, not opting in.
   */
  warnGeneric?: boolean;
}

/**
 * Normalise a date flag to an ISO string the stored `ts` can be compared against.
 *
 * Accepts a relative span (`7d`, `12h`, `30m`), a bare date (`2026-09-01`), or an ISO
 * timestamp, normalised to UTC — a bare one is local time. `endOfDay` makes a bare date an
 * inclusive upper bound — `--until 2026-09-01` meaning "through the 1st", not "up to its
 * first second".
 */
export function toISO(v: unknown, endOfDay = false): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const raw = String(v);
  const rel = parseSince(raw);
  if (rel && /^\d+[mhd]$/.test(raw)) return new Date(rel).toISOString();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + (endOfDay ? "T23:59:59Z" : "T00:00:00Z");
  // Stored stamps are UTC and compared as text, so an offset or a bare local time must be converted first.
  const t = Date.parse(raw);
  return Number.isNaN(t) ? raw : new Date(t).toISOString();
}

/**
 * Drop events that exist in more than one transcript.
 *
 * Resuming a session forks a NEW transcript and copies the history forward, so the same
 * event lives in two files, and both surface. Measured unfiltered: 213 duplicate rows out
 * of 2,403 hits (8.9%) for one query, 85 of 1,235 for another.
 *
 * THE KEY IS (ts, role, text), NOT uid — and that is the opposite of what it looks like
 * it should be. `uidOf(shape, treeKeyOf(path), seq)` hashes a LINE SLOT, not an event: a resumed
 * Claude session writes a NEW file under the SAME uuid containing NONE of the earlier
 * lines, so slot `seq` in the two copies holds two DIFFERENT events under one uid.
 * Measured across 13 real projects∩projects-1sep pairs: 4 byte-identical, 1 a strict
 * prefix, and 8 that diverge at line 1. On one of them (ff0f8c22, neo-oracle) 1,018 slots
 * carry an indexed event in BOTH copies — 1,018 distinct searchable events sharing 1,018
 * uids. Deduping on uid would silently show one and hide the other, with the winner
 * decided by whichever text happened to score higher for THAT query.
 *
 * Where uid dedup IS correct — byte-identical copies — (ts, role, text) already collapses
 * them, so the uid pass buys nothing and costs correctness. It survives only as the
 * fallback for shapes that carry no timestamp (vault, memory), whose uid hashes the FULL
 * path and therefore does identify one specific chunk of one specific file.
 *
 * Sorting by score happens FIRST, so the copy kept is the best-ranked one rather than
 * whichever shard answered first.
 */
export function dedupeHits<T extends { uid: string; ts?: string; role?: string; text?: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const h of hits) {
    const k = h.ts ? `e\u001f${h.ts}\u001f${h.role}\u001f${h.text}` : `u\u001f${h.uid}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

/**
 * The shards a query will touch, after the `--bank` and `--repo` filters.
 *
 * `repo` matches the REPO portion, never the whole key. Once the key gained a bank
 * prefix, a substring test against the key would make `--repo projects` match every
 * shard in three banks — a filter that silently widens is worse than one that errors.
 */
export function pickShards(s: Scope) {
  let all = listShards(s.dataRoot ?? null, Boolean(s.inRepo));
  if (s.bank) all = all.filter(x => x.bank === s.bank);
  return s.repo ? all.filter(x => x.repo.includes(s.repo!)) : all;
}

export interface SearchResult {
  hits: (EventRow & { repo: string })[];
  shards: number;          // shards actually read
  available: number;       // shards that matched the scope
  ms: number;
  total: number;           // hits before the limit slice
  generic?: GenericCheck;  // set when warnGeneric ran; undefined if skipped or < 2 shards
  /**
   * Under a facet filter: shards still holding channel turns with no facets, and how many
   * turns. Those turns cannot match, so "no matches" there means "not filled yet" — see
   * `index --backfill-channel`. Counted from the rows, never the schema.
   */
  unfaceted?: number;
  unfacetedTurns?: number;
  degraded?: string[];     // keys of searched shards on the `simple` tokenizer — Thai substrings missed there
}

/*
 * GENERIC-QUERY WARNING — issue #32.
 *
 * The failure this catches: a query built from ordinary English topic words (e.g.
 * "facebook transcribe") over a corpus of 1,000+ shards returns thousands of hits,
 * and the one session the user actually wants is outranked by whatever document
 * happens to repeat a query word the most — BM25 finds topics, not specific facts
 * (see help.ts). A warning belongs here because the fix is a workflow change
 * ("search a rarer literal instead"), not a ranking change.
 *
 * REJECTED: warn when `total` (raw hit count) crosses a threshold.
 *
 * Measured against 288 real queries in this repo's own `~/.relic/trace.jsonl`:
 * hits run median 259, p75 2,319, p90 8,626 — a count threshold anywhere useful
 * fires on 20-55% of ALL searches, which is a banner, not a warning. Worse, the
 * correlation runs backwards: short queries (<=25 chars, n=184) had a median of
 * 123 hits; long queries (>25 chars, n=104) had a median of 1,392 — 11x MORE, not
 * fewer, because FTS unions on every extra term, so a longer query returns a wider
 * candidate set almost by construction. The six widest queries ever logged here are
 * all multi-word common-English strings ("herdr pane run agent prompt
 * recent-unwrapped" — 95,529 hits); the narrowest are single rare identifiers
 * ("VoiceProcessingEnabled" — 1 hit). Query SHAPE carries the signal; the result
 * count does not, and penalizes longer queries in the wrong direction.
 *
 * THE SIGNAL USED INSTEAD: is every content term in the query, taken alone, common
 * across the scoped corpus? A query is only as specific as its RAREST term — one
 * rare identifier anchors an otherwise-generic sentence, and BM25's own IDF already
 * rewards it. So this samples the ACTUAL scoped shards (respecting --repo/--bank,
 * same population the real search will read) and asks, per content term: does a
 * cheap probe search for that term ALONE come back "full" (>= GENERIC_PROBE_LIMIT
 * hits) in most of the sample?
 *
 * Measured on this repo's live index (1,136 shards, `.tmp/probe4.ts` at the PR that
 * introduced this, 40-shard stratified sample, probe limit 3):
 *
 *   term                      df fraction   verdict
 *   VoiceProcessingEnabled         0.00     rare (identifier)
 *   structured_output_mode         0.00     rare (identifier)
 *   devicectl                      0.00     rare (identifier)
 *   relic                          0.00     rare (this index predates the tool)
 *   herdr                          0.07     rare (specific tool name)
 *   inserts                        0.10     rare (narrow technical noun)
 *   ambiguous                      0.38     common
 *   merge                          0.57     common
 *   facebook                       0.30     common
 *   transcribe                     0.15     borderline (see caveat below)
 *   search / run / agent / prompt  0.55-0.72 common (plain English verbs/nouns)
 *
 * Clear gap between the rare cluster (0.00-0.10) and the common cluster (0.30+),
 * so GENERIC_RARE_DF = 0.15 sits in that gap. On this data the check correctly
 * stays silent for "ambiguous merge inserts" (inserts=0.10 anchors it) and for any
 * single rare identifier, and fires for "herdr pane run agent prompt
 * recent-unwrapped" (every remaining term >= 0.55) — the two ends of the measured
 * range. "the"/"in"/"of" never reach the probe at all: they are stopwords in
 * `contentTerms`. That began as matching the index, whose tokenizer dropped them —
 * `t.search("the", "fts")` returned 0 hits, which the probe would read as "rare".
 * Since #97 the index keeps every word, so "the" would probe as common instead;
 * skipping it now just saves a probe, since a stopword can never anchor a query.
 *
 * MIN TERM COUNT IS 2, NOT NAT'S PROPOSED 3: the issue's own motivating failure —
 * "facebook transcribe" — is two words. Gating on 3 would never fire on the report
 * that opened this issue. A single term is already as narrow as a query can get
 * (nothing to union against), so 2 is the smallest count where the "wide union of
 * common terms" failure mode can occur at all.
 *
 * CAVEAT, stated plainly rather than hidden: this environment's live index is not
 * the one the issue was measured against, so "facebook transcribe" itself does not
 * reproduce the reported 3,400+ hits here (transcribe sits at 0.15, borderline
 * against the 0.15 cutoff) — the same gap nazt flagged for the original 3,400+
 * figure. The threshold is chosen from the measured rare/common gap on THIS index,
 * not from reproducing one specific historical count.
 *
 * COST: bounded regardless of corpus size. A stratified sample of up to 40 shards
 * (never the full scoped set), probe limit 3 (search can stop looking once it has
 * 3 hits), at most GENERIC_MAX_TERMS_CHECKED terms, same concurrency cap pattern as
 * the real fan-out. Measured: 27-304 ms across the queries above, against a real
 * search that is itself hundreds of ms to several seconds on this corpus.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "can", "did", "do", "does",
  "for", "from", "had", "has", "have", "how", "i", "if", "in", "is", "it", "its",
  "just", "me", "my", "no", "not", "of", "on", "or", "our", "so", "that", "the",
  "their", "them", "then", "there", "this", "to", "was", "we", "were", "what",
  "when", "where", "which", "who", "why", "will", "with", "you", "your",
]);

/** Content terms a genericity check should consider — pure, no I/O, order-preserving. */
export function contentTerms(q: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const t = raw.replace(/[^\w-]/g, "");
    if (t.length < 2) continue;
    const low = t.toLowerCase();
    if (STOPWORDS.has(low) || seen.has(low)) continue;
    seen.add(low);
    out.push(t);
  }
  return out;
}

export interface GenericCheck {
  warn: boolean;
  terms: { term: string; df: number }[];   // df = fraction of the sample where the term probed "full"
  rarest: string | null;                   // the term that most anchors the query, if any were checked
}

const GENERIC_MIN_TERMS = 2;
const GENERIC_RARE_DF = 0.15;
const GENERIC_PROBE_LIMIT = 3;
const GENERIC_SAMPLE_SHARDS = 40;
const GENERIC_MAX_TERMS_CHECKED = 8;
const GENERIC_CAP = 12;

/** Fraction of `sample` where a probe search for `term` alone comes back "full". */
async function dfFraction(term: string, sample: { dir: string }[]): Promise<number> {
  if (!sample.length) return 0;
  let common = 0, next = 0;
  await Promise.all(Array.from({ length: Math.min(GENERIC_CAP, sample.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= sample.length) return;
      try {
        const store = await LanceStore.open(sample[i].dir);
        const hits = await store.search(term, { limit: GENERIC_PROBE_LIMIT, mainTiers: true });
        if (hits.length >= GENERIC_PROBE_LIMIT) common++;
      } catch { /* a shard mid-write can throw; same tolerance as the real fan-out */ }
    }
  }));
  return common / sample.length;
}

/**
 * Warn when a query cannot plausibly isolate one session — see the block comment
 * above for the reasoning and the measurements behind the constants. Never blocks a
 * search, never changes ranking; a caller decides whether to show it.
 */
/**
 * The decision itself, split out as a PURE function — everything above it is about
 * getting a `{term, df}[]` cheaply; this is the only part with a threshold to get
 * right, so it is the only part `pure.test.ts` needs a real index to avoid testing.
 */
export function decideGeneric(results: { term: string; df: number }[]): GenericCheck {
  if (!results.length) return { warn: false, terms: [], rarest: null };
  const rarest = results.reduce((a, b) => (a.df <= b.df ? a : b));
  const warn = results.length >= GENERIC_MIN_TERMS && results.every(r => r.df > GENERIC_RARE_DF);
  return { warn, terms: results, rarest: rarest.term };
}

export async function checkGenericQuery(q: string, shards: { dir: string }[]): Promise<GenericCheck | null> {
  const terms = contentTerms(q).slice(0, GENERIC_MAX_TERMS_CHECKED);
  if (terms.length < GENERIC_MIN_TERMS || !shards.length) return null;

  // Stratified, not "first N" — shards are grouped by bank in listing order, and the
  // first N alphabetically undercounts every bank after the first (measured: the
  // first 24 of 1,136 shards, all one small bank, probed 0/24 for "herdr" and
  // "pane" both — terms this index otherwise holds thousands of times).
  const step = Math.max(1, Math.floor(shards.length / GENERIC_SAMPLE_SHARDS));
  const sample = shards.filter((_, i) => i % step === 0).slice(0, GENERIC_SAMPLE_SHARDS);

  const results: { term: string; df: number }[] = [];
  for (const term of terms) results.push({ term, df: await dfFraction(term, sample) });

  return decideGeneric(results);
}

/** One line for a search header when any searched shard fell back to `simple` — null otherwise. */
export function degradedNote(degraded: string[] | undefined, searched: number): string | null {
  if (!degraded?.length) return null;
  const names = degraded.slice(0, 3).map(k => k.replace("github.com/", "")).join(", ");
  return `\u26A0 ${degraded.length} of ${searched} shards searched use the \`simple\` tokenizer (no ICU where they were ` +
         `indexed) — Thai word-internal matches are missed there: ${names}${degraded.length > 3 ? ", ..." : ""}`;
}

export async function searchEvents(q: string, o: SearchOpts = {}): Promise<SearchResult> {
  const limit = o.limit ?? 20;
  const shards = pickShards(o);
  const hits: (EventRow & { repo: string })[] = [];
  const degraded: string[] = [];
  let searched = 0;
  const t0 = performance.now();

  /*
   * Query shards CONCURRENTLY.
   *
   * Each shard is an independent LanceDB directory, so the fan-out was 345 sequential
   * round-trips that shared nothing but the result array — measured at ~7 s unfiltered,
   * against ~330 ms for a single `--repo`. The work is IO-bound, so it overlaps well.
   *
   * Bounded, not unbounded: opening 345 LanceDB connections at once trades a latency
   * problem for a file-descriptor one. The cap tracks CPU count the same way the agent
   * runner does, with a floor so a small machine still overlaps.
   *
   * Measured on 345 shards, "peak concurrency", average of 3 runs each — single runs
   * vary by ~2 s here, so one-shot comparisons of this are worthless:
   *
   *   cap  1 (sequential)   9,211 ms
   *   cap 16 (default)      6,206 ms     <- 1.5x, not the 2.4x a single run suggested
   *   cap 32                6,762 ms
   *   cap 64                5,972 ms     <- no reliable gain above 16
   *
   * Concurrency softens the fan-out; it does not remove it, because the cost is 345
   * real FTS queries. Narrowing with `repo` is still worth an order of magnitude more
   * than any cap. RELIC_FANOUT overrides for measurement.
   */
  const CAP = Number(process.env.RELIC_FANOUT) > 0
    ? Number(process.env.RELIC_FANOUT)
    : Math.max(4, Math.min(16, (os.cpus?.().length ?? 8) - 2));
  /*
   * DEFAULT TO THE MAIN CONVERSATION.
   *
   * By file count the corpus is 73% workflow_agent (21,305 vs 7,327 session), and those
   * are an agent talking to itself inside one fan-out — near-duplicate prompts, tool
   * chatter, and the same instructions restated N times. The human's own thread is
   * where a decision was actually made.
   *
   * Measured before this default existed: unfiltered top-20 was already 60-75% session,
   * because BM25 favours the denser prose anyway. So this is not rescuing a drowned
   * signal — it is removing the remaining 25-40% of agent noise from the common case,
   * and cutting the work the fan-out does. `allTiers` gets it all back, and the CLI and
   * MCP both SAY SO on every result rather than silently narrowing.
   */
  /*
   * The default narrows to session AND note — not session alone.
   *
   * Vault notes are the OPPOSITE of the noise the tier default exists to cut: hand
   * written, one per idea, no near-duplicates. Excluding them would make `relic
   * search` silently miss the most deliberate writing in the corpus.
   *
   * `tier` must stay UNDEFINED when defaulting, or the store's `if (opts.tier)`
   * branch pins it to a single value and the multi-tier filter below is dead code.
   * That was the bug: default returned {session:30, note:0} while --all-tiers found
   * notes fine, so the vault indexed correctly and was invisible anyway.
   */
  const mainOnly = !o.tier && !o.allTiers;
  const tier = o.tier;
  const opts = { limit, tier, mainTiers: mainOnly, source: o.source, worktree: o.worktree, path: o.path,
                 org: o.org, project: o.project, dir: o.dir, memType: o.memType,
                 since: toISO(o.since), until: toISO(o.until, true), role: o.role, prose: o.prose,
                 via: o.via, chat: o.chat, fromUser: o.fromUser };
  const faceting = Boolean(o.via || o.chat || o.fromUser);
  let unfaceted = 0, unfacetedTurns = 0;

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CAP, shards.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= shards.length) return;
      const s = shards[i];
      try {
        const store = await LanceStore.open(s.dir);
        /*
         * Counted, not just skipped: an empty answer from turns that CANNOT match reads
         * exactly like one that did not. From the rows, not the schema — the schema says
         * "faceted" from the first ordinary index write onward, while every older channel
         * row in the shard still has via = "". Measured: 1.1 s over the whole index.
         */
        if (faceting) {
          const stale = (await store.unfacetedChannelTexts()).filter(t => parseChannelEnvelope(t)).length;
          if (stale) { unfaceted++; unfacetedTurns += stale; }
        }
        for (const h of await store.search(q, opts)) hits.push({ ...h, repo: s.key });
        searched++;
        if ((await store.ftsTokenizer()) === "simple") degraded.push(s.key);
      } catch { /* a shard mid-write can throw; skip rather than abort the fan-out */ }
    }
  }));
  /*
   * RANK ACROSS SHARDS BEFORE SLICING.
   *
   * Each shard returns its own top-`limit`; without this the caller sliced the
   * CONCATENATION in shard-iteration order, so the "top 20" was really "whatever the
   * first shards happened to hold". Measured on "peak concurrency" over 345 shards
   * and 1,493 hits: the displayed top-10 shared 1 result with the actual best 10, all
   * ten came from a single repo, and the best score shown was 14.46 against 19.84
   * available. LanceDB returned `_score` the whole time and it was discarded.
   *
   * Honest limit: BM25 is computed per index, so IDF reflects each shard's own corpus
   * and the scores are not strictly commensurable. They are close enough to be worth
   * far more than arrival order — same engine, same tokenizer, same schema — but this
   * is a ranking improvement, not a globally correct BM25.
   */
  hits.sort((a, b) => Number((b as any)._score ?? 0) - Number((a as any)._score ?? 0));

  const deduped = dedupeHits(hits);
  hits.length = 0;
  hits.push(...deduped);

  // Scoped to the SAME shards the search itself read — a warning about --repo neo
  // should be relative to neo's corpus, not the whole index.
  const generic = o.warnGeneric === false ? undefined : (await checkGenericQuery(q, shards)) ?? undefined;

  return { hits, shards: searched, available: shards.length,
           ms: Math.round(performance.now() - t0), total: hits.length, generic, degraded: degraded.sort(),
           ...(faceting && { unfaceted, unfacetedTurns }) };
}

export interface SemanticOpts extends Scope {
  limit?: number; overfetch?: number; allTiers?: boolean;
  tier?: string; role?: string; source?: string; since?: string; until?: string;
  device?: string; session?: string;
}

export interface SemanticResult extends SearchResult {
  model: string;            // what the SHARDS say made their vectors
  embedded: number;         // shards that actually held vectors
  unembedded: number;       // scoped shards with none — the silent-zero guard
  queryMs: number;          // cost of embedding the query, separately from the search
}

/**
 * Nearest-neighbour search over the `vectors` table.
 *
 * NOT the default, and not blended into `search`. Measured on this corpus: on
 * known-item queries FTS scores 0.890 MRR@20 against 0.600, and it adds one query in
 * 200 to what FTS already finds; on paraphrase queries the order flips to 0.140 against
 * 0.046. RRF fusion lost at every k in BOTH directions, so this is a separate mode the
 * caller chooses, never a re-ranking of the lexical one.
 *
 * THE MODEL COMES FROM THE SHARDS, never from a flag. Every vector was written with a
 * recorded model id, and embedding a query with a different model produces confident
 * nonsense rather than an error — both sides are floats of the same width and the
 * distance computes fine. So the scoped shards are asked what they hold, a disagreement
 * is refused rather than averaged, and the query is embedded once with that model.
 */
export async function semanticSearch(q: string, o: SemanticOpts = {}): Promise<SemanticResult> {
  const t0 = performance.now();
  const limit = o.limit ?? 20;
  const shards = pickShards(o);

  // Which shards actually carry vectors, and made by what.
  const models = new Map<string, number>();
  const withVectors: typeof shards = [];
  for (const s of shards) {
    try {
      const st = await (await LanceStore.open(s.dir)).vectorStats();
      if (!st?.rows || !st.model) continue;
      withVectors.push(s);
      models.set(st.model, (models.get(st.model) ?? 0) + st.rows);
    } catch { /* unreadable shard holds no vectors as far as this is concerned */ }
  }
  if (!withVectors.length)
    throw new Error(
      `no vectors in the ${shards.length} scoped shard(s). \`relic index\` never writes them — ` +
      `run \`relic embed --dry-run\` to see what embedding would cost, or narrow with --bank.`);
  if (models.size > 1)
    throw new Error(
      `scoped shards hold vectors from ${models.size} different models and their distances are ` +
      `not comparable: ${[...models].map(([m, n]) => `${m} (${n.toLocaleString()} vectors)`).join(", ")}. ` +
      `Narrow with --bank/--repo, or re-embed one of them with --reset.`);

  const model = [...models.keys()][0];
  const provider = queryProviderFor(model, o.device);
  const q0 = performance.now();
  let vec: number[];
  try {
    [vec] = await provider.embed([q]);
  } finally {
    provider.close?.();      // an st sidecar holds a model until told otherwise
  }
  const queryMs = Math.round(performance.now() - q0);

  const opts = { limit, overfetch: o.overfetch, session: o.session,
                 mainTiers: !o.allTiers && !o.tier, tier: o.tier, role: o.role,
                 source: o.source, since: toISO(o.since), until: toISO(o.until, true) };

  const hits: (EventRow & { repo: string })[] = [];
  let searched = 0;
  const CAP = Number(process.env.RELIC_FANOUT) > 0
    ? Number(process.env.RELIC_FANOUT)
    : Math.max(4, Math.min(16, (os.cpus?.().length ?? 8) - 2));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CAP, withVectors.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= withVectors.length) return;
      const s = withVectors[i];
      try {
        const store = await LanceStore.open(s.dir);
        for (const h of await store.vectorSearch(vec, opts)) hits.push({ ...h, repo: s.key });
        searched++;
      } catch { /* a shard mid-write can throw; skip rather than abort the fan-out */ }
    }
  }));

  // Rank across shards before slicing, same as the lexical path — and unlike BM25, a
  // cosine IS commensurable between shards: the same model, the same unit sphere, no
  // per-index IDF. This is the one place the semantic path has a cleaner claim.
  hits.sort((a, b) => Number((b as any)._score ?? 0) - Number((a as any)._score ?? 0));

  /*
   * COLLAPSE BY CONTENT, on top of the shared dedupe — semantic only.
   *
   * dedupeHits keys on (ts, role, text), which is right for transcripts: a resumed
   * session rewrites the same line slot with a different event, so identical text at a
   * different timestamp is a different event. It is wrong for documents. One lesson
   * file copied into three oracle vaults carries three different dates and identical
   * prose, and a nearest-neighbour query returns all three at the same distance —
   * measured: the top THREE hits of the first semantic search ever run here were one
   * note, filling a four-result page.
   *
   * Only the semantic path collapses them. Lexical search is unchanged, deliberately:
   * BM25 ranks by term statistics, so duplicates rarely stack at the top the way an
   * exact-duplicate vector does, and quietly changing what `search` returns to fix a
   * problem it does not have is how a narrow fix becomes a regression.
   */
  const byText = new Map<string, EventRow & { repo: string; _dupes?: number }>();
  for (const h of dedupeHits(hits)) {
    const k = String(h.text ?? "").replace(/\s+/g, " ").trim();
    const prior = byText.get(k);
    if (!prior) { byText.set(k, { ...h, _dupes: 0 }); continue; }
    prior._dupes = (prior._dupes ?? 0) + 1;   // keep the best-scoring copy, count the rest
  }
  const deduped = [...byText.values()].slice(0, limit);

  return { hits: deduped, shards: searched, available: shards.length,
           ms: Math.round(performance.now() - t0), total: deduped.length,
           model, embedded: withVectors.length,
           unembedded: shards.length - withVectors.length, queryMs };
}

export interface SessionsOpts extends Scope {
  limit?: number; since?: string; until?: string; worktree?: string;
  /** false lists every transcript separately, children included. Default true. */
  group?: boolean;
  /** Which `tier` values count. Defaults to TRANSCRIPT_TIERS — see store.sessions(). */
  tiers?: string[];
}

/**
 * The three tiers that are a CONVERSATION. `note` and `memory` are other kinds of
 * thing that happen to share the table, and they outnumber conversations 100:1.
 */
export const TRANSCRIPT_TIERS = ["session", "subagent", "workflow_agent"];

/** A session row plus what its children add up to. */
export type SessionSummary = SessionRow & {
  repo: string;
  children: number;      // subagent + workflow_agent transcripts under it
  treeEvents: number;    // events across the whole tree, not just the parent
};

export interface SessionsResult {
  rows: SessionSummary[];                    // already sliced to `limit`
  total: number;                             // conversations, after grouping
  transcripts: number;                       // files behind them
  events: number;                            // summed over ALL matches
  shards: number;
}

/**
 * Fold a flat transcript list into one row per conversation.
 *
 * Without this, `sessions` counts FILES: one fan-out that spawned 110 workflow agents
 * reads as 111 sessions, all sharing a uuid, and the listing fills with agent prompts
 * instead of the human's. Measured on this index — 325 rows over 3 days collapse to 44
 * real conversations.
 *
 * The parent row represents the group. When a tree was indexed without its parent
 * (possible: children are separate files), the earliest child stands in, so a session
 * is never silently dropped.
 */
function groupTranscripts(rows: (SessionRow & { repo: string })[]): SessionSummary[] {
  const by = new Map<string, (SessionRow & { repo: string })[]>();
  for (const r of rows) {
    /*
     * KEY ON (repo, session_uuid), not the uuid alone.
     *
     * The same uuid appears under a resolved repo AND under `_unresolved` when part of
     * a tree was indexed before its cwd could be attributed — a pre-existing indexing
     * artifact. Keying on the uuid merges those into one row and silently loses trees:
     * 4 of them on the live index. report.ts already keys on the pair and was right;
     * this was the odd one out, and relic-py matched report.ts when it was ported.
     */
    const k = r.session_uuid ? `${r.repo}\u0000${r.session_uuid}` : r.file_path;
    (by.get(k) ?? by.set(k, []).get(k)!).push(r);
  }
  const out: SessionSummary[] = [];
  for (const group of by.values()) {
    group.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    const parent = group.find(r => r.tier === "session") ?? group[0];
    out.push({
      ...parent,
      children: group.length - 1,
      treeEvents: group.reduce((a, r) => a + Number(r.event_count ?? 0), 0),
    });
  }
  return out;
}

export async function listSessions(o: SessionsOpts = {}): Promise<SessionsResult> {
  const shards = pickShards(o);
  const rows: (SessionRow & { repo: string })[] = [];
  let searched = 0;
  for (const sh of shards) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.sessions({
        since: toISO(o.since), until: toISO(o.until, true), worktree: o.worktree,
        tiers: o.tiers ?? TRANSCRIPT_TIERS,
      })) rows.push({ ...r, repo: sh.key });
      searched++;
    } catch { /* skip unreadable shard */ }
  }
  const events = rows.reduce((a, r) => a + Number(r.event_count ?? 0), 0);
  const grouped = o.group === false
    ? rows.map(r => ({ ...r, children: 0, treeEvents: Number(r.event_count ?? 0) }))
    : groupTranscripts(rows);
  grouped.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return { rows: grouped.slice(0, o.limit ?? 40), total: grouped.length,
           transcripts: rows.length, events, shards: searched };
}

/**
 * Does this look like a session id, or like a name?
 *
 * A Claude/Codex session id is hex-and-dashes, so anything with a letter past `f`, a
 * space, or punctuation is a name. Getting this wrong is cheap in one direction only:
 * a name tried as an id returns nothing, so `resolveSession` tries the id first and
 * falls back — it never refuses to look.
 */
export function looksLikeId(s: string): boolean {
  return /^[0-9a-f]{4,}(-[0-9a-f]+)*$/i.test(s.trim());
}

/** Sessions matching a NAME — the host's title, or the opening message. Parents only. */
export async function findSessionByName(q: string, s: Scope = {}, limit = 40): Promise<(SessionRow & { repo: string })[]> {
  const rows: (SessionRow & { repo: string })[] = [];
  for (const sh of pickShards(s)) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.findSessionByName(q, limit)) rows.push({ ...r, repo: sh.key });
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  return rows.slice(0, limit);
}

/** Every indexed transcript whose session_uuid starts with `id`. Index only. */
export async function findSessionById(id: string, s: Scope = {}): Promise<(SessionRow & { repo: string })[]> {
  const rows: (SessionRow & { repo: string })[] = [];
  for (const sh of pickShards(s)) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.findSession(id)) rows.push({ ...r, repo: sh.key });
    } catch { /* skip unreadable shard */ }
  }
  return rows;
}

export interface ResolveResult {
  rows: (SessionRow & { repo: string })[];
  imported: number;    // files pulled in on demand, 0 when the index already had it
  matchedBy: "id" | "name" | "none";
}

/**
 * SEEK -> INDEX -> ANSWER.
 *
 * A session id maps to a filename, so a miss in the index is not an answer — it means
 * the file has not been imported yet. Locating it on disk is deterministic and importing
 * one file is fast, so do both rather than returning "run index first" and making the
 * caller improvise a `find`.
 */
export async function resolveSession(
  id: string, s: Scope & { noIndex?: boolean; skipNoise?: boolean } = {},
): Promise<ResolveResult> {
  const rows = await findSessionById(id, s);
  if (rows.length) return { rows, imported: 0, matchedBy: "id" };

  // Only seek on disk for something that could BE a filename. A name has no file to
  // find, so seeking on it would walk every source directory to return nothing.
  if (!s.noIndex && looksLikeId(id)) {
    const found = seekOnDisk(id);
    if (found.length) {
      await importFiles(found, {
        dataRoot: s.dataRoot ?? null, inRepo: Boolean(s.inRepo), skipNoise: Boolean(s.skipNoise),
      });
      return { rows: await findSessionById(id, s), imported: found.length, matchedBy: "id" };
    }
  }

  // Fall back to the name. Ambiguity is the caller's to resolve: return every match
  // rather than picking one, because two sessions can share a title.
  const byName = await findSessionByName(id, s);
  if (!byName.length) return { rows: [], imported: 0, matchedBy: "none" };

  // A name matches the PARENT row only — titles belong to the conversation. Expand a
  // unique match back to its whole tree, so `session <name>` and `session <id>` answer
  // with the same thing. Without this the same session reports 1 transcript or 122
  // depending on how it was named, which is the kind of inconsistency that makes a
  // caller stop trusting the tool.
  const uuids = new Set(byName.map(r => r.session_uuid));
  if (uuids.size === 1) {
    const tree = await findSessionById(byName[0].session_uuid, s);
    if (tree.length) return { rows: tree, imported: 0, matchedBy: "name" };
  }
  return { rows: byName, imported: 0, matchedBy: "name" };
}

export interface Unindexed { missing: number; onDisk: number; repo: string }

/**
 * Transcripts of this tree that exist on disk but have no index row. A --since-windowed
 * index silently drops old subagents, and `chain` then reads as "nothing ran" (#72).
 */
export function unindexedOf(rows: ChainRow[]): Unindexed | null {
  const trees = new Map<string, { dir: string; uuid: string; paths: Set<string>; repo: string }>();
  for (const r of rows) {
    const i = r.project_dir ? r.file_path.indexOf(`/${r.project_dir}/`) : -1;
    if (i < 0) continue;
    const dir = r.file_path.slice(0, i + 1 + r.project_dir.length);
    const k = `${dir}\0${r.session_uuid}`;
    if (!trees.has(k)) trees.set(k, { dir, uuid: r.session_uuid, paths: new Set(), repo: r.repo_key });
    trees.get(k)!.paths.add(r.file_path);
  }
  let worst: Unindexed | null = null;
  for (const t of trees.values()) {
    const files = treeFiles(t.dir, t.uuid);
    // Claude's layout only: <dir>/<uuid>.jsonl plus <dir>/<uuid>/subagents/.
    if (!files.some(f => f.tier === "session")) continue;
    const missing = files.filter(f => !t.paths.has(f.path)).length;
    if (missing && (!worst || missing > worst.missing)) worst = { missing, onDisk: files.length, repo: t.repo };
  }
  return worst;
}

export function unindexedHint(u: Unindexed): string {
  const repo = u.repo && u.repo !== "_unresolved" ? ` --repo ${u.repo.replace(/^github\.com\//, "")}` : "";
  return `(!) ${u.missing} of ${u.onDisk} transcripts in this tree are not indexed — reindex: relic index${repo}`;
}

/** The session tree on one time axis. Resolves the id the same way `session` does. */
export async function chainOf(
  id: string, s: Scope & { noIndex?: boolean; skipNoise?: boolean } = {},
): Promise<{ chain: Chain | null; imported: number; unindexed: Unindexed | null }> {
  const { rows, imported } = await resolveSession(id, s);
  return { chain: rows.length ? buildChain(id, rows as ChainRow[]) : null, imported,
           unindexed: rows.length ? unindexedOf(rows as ChainRow[]) : null };
}

export interface ContextLine { seq: number; role: string; text: string; target: boolean }

/**
 * Read the lines around one event, straight from the source `.jsonl`.
 *
 * The index stores a POINTER, not an archive — so this reads the file rather than the
 * shard, and stays correct for a transcript that has been appended to since indexing.
 */
export async function readAround(
  path: string, target: number, before = 2, after = 2,
): Promise<ContextLine[]> {
  // A Hermes "file" is <db>#<session_id> — there is nothing to open as a stream.
  // Without this, every Hermes search result printed a `show` pointer that crashed
  // with ENOENT, which makes a hit unopenable and the source effectively read-only.
  if (path.includes(".db#")) {
    const { parseHermes } = await import("./shapes/hermes.js");
    const p = await parseHermes(path);
    return p.events
      .filter(e => e.seq >= target - before && e.seq <= target + after)
      .map(e => ({ seq: e.seq, role: e.role, text: e.text, target: e.seq === target }));
  }

  const out: ContextLine[] = [];
  const rl = createInterface({ input: createReadStream(path, "utf8") });
  let seq = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    seq++;
    if (seq < target - before) continue;
    if (seq > target + after) break;
    let role = "?", text: string = line.slice(0, 400);
    try {
      const rec = JSON.parse(line);
      role = rec.message?.role ?? rec.type ?? "?";
      const c = rec.message?.content ?? rec.payload?.content ?? rec.content;
      text = typeof c === "string" ? c : JSON.stringify(c ?? rec).slice(0, 600);
    } catch { /* a half-written last line is normal on a live transcript */ }
    out.push({ seq, role, text: String(text), target: seq === target });
  }
  rl.close();
  return out;
}

/**
 * One row per SHARD, which since banks is one row per (bank, repo) — not per repo.
 *
 * `key` is the full shard key, "<bank>/github.com/<org>/<repo>". It is a display
 * string and NOTHING accepts it as a filter: `repo` matches the repo portion and
 * `bank` matches the bank exactly. Callers that render a filter hint must use the
 * split fields, never `key` — printing a key beside "this is what `repo` accepts"
 * is the exact bug this split exists to prevent.
 */
export interface ShardStat {
  key: string; bank: string; repo: string; events: number;
  /**
   * ROWS IN THE sessions TABLE — one per TRANSCRIPT, not per conversation.
   *
   * A fan-out that spawned 110 workflow agents stores 111 rows sharing one
   * session_uuid. Rendering this number under the word "sessions" overstated the
   * count 5.5x on a real index (1,790 shown, 323 actual), and it was on a status
   * board, which is the worst place for a confident wrong number.
   *
   * Callers that mean CONVERSATIONS must group by (repo, session_uuid) — see
   * groupTranscripts — or say "transcripts" in the output. The field keeps its name
   * for compatibility; the comment is the contract.
   */
  sessions: number;
  /** max(files.imported_at) — when the indexer last wrote this shard. "" if never. */
  lastIndexed: string;
  /** max(sessions.started_at) — when this shard's newest transcript began. "" if none. */
  newestSession: string;
  /** The full-text tokenizer: "simple" = Thai substring search degraded, "none" = LIKE scan. */
  fts: "icu" | "simple" | "none";
}

/**
 * Per-shard counts, biggest first.
 *
 * This doubles as DISCOVERY, and it discovers TWO filters, not one: `bank` takes a
 * row's `bank` exactly, `repo` takes a substring of its `repo`. It used to be one —
 * before banks the shard key WAS the repo key — and the rendering that assumed so
 * printed "<bank>/github.com/<org>/<repo>" under the heading "what `repo` accepts",
 * which matches nothing. Render from `bank` and `repo`; `key` is for display only.
 */
export interface BankGroup<T> {
  bank: string; rows: T[]; events: number; sessions: number; shards: number;
  /** Newest value across the group — "" when no row in it has one. */
  lastIndexed: string; newestSession: string;
}

/** Newest non-empty ISO string in a list, or "" — max() over strings that may be absent. */
export function maxISO(xs: (string | undefined)[]): string {
  let best = "";
  for (const x of xs) { const v = x ?? ""; if (v > best) best = v; }
  return best;
}

/**
 * Group shard rows by bank, biggest bank first, biggest repo first within each.
 *
 * A FLAT list sorted by size interleaves what are really several snapshots of the same
 * machine, and the reader cannot tell whether a repo appears three times because it is
 * busy or because it exists in three banks. Both the CLI and the MCP render from this,
 * because the CLI grouped and the MCP did not, and that divergence is what let the MCP
 * ship a repo-filter hint that matched nothing.
 */
export function groupByBank<T extends { bank: string; events: number; sessions: number;
                                        lastIndexed?: string; newestSession?: string }>(
  rows: T[],
): BankGroup<T>[] {
  const by = new Map<string, T[]>();
  for (const r of rows) { const a = by.get(r.bank) ?? []; a.push(r); by.set(r.bank, a); }
  return [...by.entries()]
    .map(([bank, rs]) => ({
      bank,
      rows: [...rs].sort((a, b) => b.events - a.events),
      events: rs.reduce((n, r) => n + r.events, 0),
      sessions: rs.reduce((n, r) => n + r.sessions, 0),
      shards: rs.length,
      lastIndexed: maxISO(rs.map(r => r.lastIndexed)),
      newestSession: maxISO(rs.map(r => r.newestSession)),
    }))
    .sort((a, b) => b.events - a.events);
}

export async function indexStatus(
  s: Scope & { freshness?: boolean } = {},
): Promise<{ root: string; rows: ShardStat[] }> {
  const { defaultRoot } = await import("./repo.js");
  const rows: ShardStat[] = [];
  for (const sh of pickShards(s)) {
    try {
      const st = await LanceStore.open(sh.dir);
      const c = await st.counts();
      const fr = s.freshness === false ? { lastIndexed: "", newestSession: "" } : await st.freshness();
      rows.push({ key: sh.key, bank: sh.bank, repo: sh.repo, events: c.events, sessions: c.sessions,
                  lastIndexed: fr.lastIndexed, newestSession: fr.newestSession,
                  fts: (await st.ftsTokenizer()) ?? "none" });
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => b.events - a.events);
  return { root: s.dataRoot ?? defaultRoot(), rows };
}

export interface SessionStats {
  transcripts: number; events: number;
  tiers: { tier: string; n: number }[];
  runs: number;                 // distinct workflow runs
  startedAt: string; endedAt: string;
  repo: string; worktree: string; model: string;
}

/** Roll a session's tree up into the few numbers worth printing above it. */
export function statsOf(rows: (SessionRow & { repo: string })[]): SessionStats | null {
  if (!rows.length) return null;
  const tiers = new Map<string, number>();
  const runs = new Set<string>();
  let events = 0, start = "", end = "";
  for (const r of rows) {
    tiers.set(r.tier, (tiers.get(r.tier) ?? 0) + 1);
    if (r.workflow_run_id) runs.add(r.workflow_run_id);
    events += Number(r.event_count ?? 0);
    const s = String(r.started_at ?? ""), e = String(r.ended_at ?? "");
    if (s && (!start || s < start)) start = s;
    if (e && (!end || e > end)) end = e;
  }
  const parent = rows.find(r => r.tier === "session") ?? rows[0];
  return {
    transcripts: rows.length, events,
    tiers: [...tiers].map(([tier, n]) => ({ tier, n })).sort((a, b) => b.n - a.n),
    runs: runs.size, startedAt: start, endedAt: end,
    repo: parent.repo, worktree: parent.worktree ?? "", model: parent.model ?? "",
  };
}

export interface Neighbours {
  before: (SessionRow & { repo: string })[];
  after: (SessionRow & { repo: string })[];
}

/**
 * The sessions either side of this one, same repo, same worktree.
 *
 * A session rarely stands alone — it is one stretch of a longer thread of work, and
 * the question that follows "which session was that" is almost always "and what came
 * before it". Answering that from a session row alone means going back to the index
 * with a hand-built time filter, which is exactly the improvisation the tool exists to
 * remove. Scoped to the same worktree because that, not the repo, is the unit of work.
 */
export async function neighbours(
  row: SessionRow & { repo: string }, s: Scope = {}, before = 5, after = 5,
): Promise<Neighbours> {
  const iso = String(row.started_at ?? "");
  if (!iso) return { before: [], after: [] };
  // `row.repo` is a full shard KEY ("<bank>/github.com/<org>/<repo>"), not a repo name,
  // so it must not be fed to the `repo` filter — that filter now matches the repo
  // portion and would return nothing, leaving this function silently empty.
  const all = pickShards({ dataRoot: s.dataRoot, inRepo: s.inRepo });
  const shard = all.find(x => x.key === row.repo);
  if (!shard) return { before: [], after: [] };
  // EVERY bank holding this repo, not just the one the parent was found in. The three
  // Claude roots are snapshots of the same machine, so "the session before this one"
  // frequently lives in a different bank — answering from one bank silently drops it.
  const sibling = all.filter(x => x.repo === shard.repo);
  const out: Neighbours = { before: [], after: [] };
  for (const sh of sibling) {
    try {
      const store = await LanceStore.open(sh.dir);
      const n = await store.around(iso, { worktree: row.worktree || undefined, before, after });
      const tag = (r: SessionRow) => ({ ...r, repo: sh.key });
      out.before.push(...n.before.map(tag));
      out.after.push(...n.after.map(tag));
    } catch { /* a shard mid-write can throw; the others still answer */ }
  }
  // One row per session across banks; keep the copy with the most events, then re-slice
  // — each shard returned its own N, and N shards' worth is not the answer.
  const fold = (rs: (SessionRow & { repo: string })[], newestFirst: boolean) => {
    const best = new Map<string, SessionRow & { repo: string }>();
    for (const r of rs) {
      const k = String(r.session_uuid);
      const cur = best.get(k);
      if (!cur || Number(r.event_count ?? 0) > Number(cur.event_count ?? 0)) best.set(k, r);
    }
    const sorted = [...best.values()].sort((a, b) =>
      String(a.started_at ?? "").localeCompare(String(b.started_at ?? "")));
    return newestFirst ? sorted.slice(-before) : sorted.slice(0, after);
  };
  return { before: fold(out.before, true), after: fold(out.after, false) };
}

/**
 * Display name for a session: the host's own title, else its opening message.
 *
 * The fallback needs cleaning because an opening message is very often a slash command,
 * and Claude Code stores those wrapped in markup a human never typed —
 * `<command-message>dig</command-message><command-name>/dig</command-name>` and the
 * `<local-command-caveat>` preamble. Shown raw, the listing fills with tag soup and
 * every /dig session looks identical.
 */
/**
 * A session's human-readable name. Takes the two fields it reads rather than a
 * SessionRow, so `pending` — which has a parsed transcript and no row, because the
 * whole point is that it is not in the index — can call the same function. Two copies
 * of this would drift on the slash-command branch and nobody would notice.
 */
export function nameOf(r: { title?: unknown; description?: unknown }): string {
  const t = String((r as any).title ?? "").trim();
  if (t) return t;

  let d = String(r.description ?? "");
  // A slash command: the command NAME is the useful part, so promote it.
  const cmd = d.match(/<command-name>\s*(\/?[\w:-]+)\s*<\/command-name>/)?.[1];
  const args = d.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
  if (cmd) return (args ? `${cmd} ${args}` : cmd).replace(/\s+/g, " ").slice(0, 70);

  // description is truncated at 200 chars, so a caveat block often has no closing tag
  // to match against. Drop from the opening tag to the end rather than leaving the
  // boilerplate as the session's name.
  // A host's own boot directive is not a name. Claude's two shapes were already
  // handled below; Codex's three were not, and they account for 64% of its sessions.
  if (isHostPreamble(d)) return "(untitled)";

  // Rows indexed before import stripped envelopes still carry them, cut at 200 chars.
  d = stripEnvelope(d.replace(/\.\.\.\[\+\d+\]$/, ""));
  if (isHostPreamble(d)) return "(untitled)";

  d = d.replace(/<local-command-caveat>[\s\S]*$/, "")
       .replace(/^\s*Caveat: The messages below were generated[\s\S]*$/, "")
       // A pasted image carries a long tag the {1,40} scrubber below cannot reach, and
       // a message is often JUST the tag. Whatever the human typed after it is the name.
       .replace(/<image\b[^>]*>/gi, " ")
       .replace(/<[^>]{1,40}>/g, " ")
       .replace(/\s+/g, " ").trim();
  return d ? d.slice(0, 70) : "(untitled)";
}

/** `#…214730` — the tail of a snowflake tells rooms apart; a short id is shown whole. */
export function chatLabel(id: string): string {
  return id.length > 8 ? `#…${id.slice(-6)}` : `#${id}`;
}

/**
 * `[discord #…214730 +2 · nazt_, ting_41427]` — where a session lived and who spoke,
 * from the session row's channel columns. "" when nothing arrived by channel, or the
 * row predates the columns.
 *
 * BESIDE the name, never inside it (#86 proposed a prefix). nameOf is the words a human
 * typed: `session <name>` matches on them, pending and report print them, and a prefix
 * would push the words past the 70-char cut on exactly the sessions that have one.
 */
export function roomTag(r: { via?: unknown; chat_id?: unknown; from_users?: unknown }, o: { full?: boolean } = {}): string {
  const list = (v: unknown) => String(v ?? "").split(",").filter(Boolean);
  const chats = list(r.chat_id), users = list(r.from_users);
  const via = o.full ? list(r.via) : [...new Set(list(r.via).map(viaLabel))];
  if (!via.length) return "";
  // Full ids for a model: a reply through a channel plugin needs the whole chat_id.
  const room = !chats.length ? ""
    : o.full ? ` chat_id ${chats.slice(0, 5).join(", ")}${chats.length > 5 ? ` +${chats.length - 5}` : ""}`
    : ` ${chatLabel(chats[0])}${chats.length > 1 ? ` +${chats.length - 1}` : ""}`;
  const who = users.slice(0, 3).join(", ") + (users.length > 3 ? ` +${users.length - 3}` : "");
  return `[${via.join("+")}${room}${who ? ` · ${who}` : ""}]`;
}

/**
 * `nazt_ @ discord #…214730 · sent 2026-08-20 21:37 UTC+07` — who, where and when, for one
 * hit. `full` is the model's form: every id whole and the sender's clock as stored, because
 * a reply through the channel plugin is addressed by the exact chat_id and message_id.
 */
export function channelHead(c: ChannelFacets, o: { full?: boolean } = {}): string {
  if (o.full)
    return [c.from_user && `${c.from_user}${c.from_user_id ? ` (user_id ${c.from_user_id})` : ""}`, `via ${c.via}`,
            c.chat_id && `chat_id ${c.chat_id}`, c.msg_id && `message_id ${c.msg_id}`, c.sent_ts && `sent ${c.sent_ts}`]
      .filter(Boolean).join(" · ");
  const where = `${viaLabel(c.via)}${c.chat_id ? ` ${chatLabel(c.chat_id)}` : ""}`;
  // The zone is named: a hit's own `ts` prints as UTC ISO on the line above this one.
  const t = Date.parse(c.sent_ts);
  const when = !c.sent_ts ? "" : Number.isNaN(t) ? ` · sent ${c.sent_ts}`
             : ` · sent ${localDateTime(t)} UTC${zoneOffset(new Date(t))}`;
  return `${c.from_user ? `${c.from_user} @ ${where}` : where}${when}`;
}

/**
 * A facet filter's value, as the store needs it: a string, or undefined when not given.
 *
 * Checked at the edge because the fan-out swallows per-shard errors: a bare `--via`
 * arrives as `true` and an MCP client can send `chat: 214730` as a number, and either one
 * used to throw inside every shard and come back as "no matches across 0 shards".
 */
export function facetArg(name: string, v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "boolean") throw new Error(`${name} needs a value, e.g. ${name} discord`);
  const s = String(v).trim();
  if (!s) throw new Error(`${name} needs a non-empty value`);
  return s;
}


/**
 * How far the index has fallen behind the file it points at.
 *
 * relic stores a POINTER, not an archive, so a live session keeps growing after it was
 * imported — that is by design. It only becomes a trap when two commands are compared:
 * `dig` reads the file and `session` reads the index, so they report different end
 * times for the same session and the difference looks like a timezone bug. Measured
 * here: index ended 09:27Z, file had reached 10:28Z, exactly one hour of drift.
 *
 * Returns null when the file is gone or the index is current.
 */
/**
 * How old is the index BEHIND THIS ANSWER?
 *
 * A ranked list from a stale index is worse than an empty one: it is confident,
 * relevant-looking, and silently scoped to whatever happened to be indexed. The header
 * reported shard count and query latency — neither is the number that changes how you
 * read the results.
 *
 * SCOPED TO THE SHARDS THAT PRODUCED HITS, for two reasons. It is the relevant
 * population — "how current is what answered me" — and it is affordable: `freshness()`
 * full-scans two columns per shard, measured at 9.1 ms, so asking all 1,136 shards
 * costs 10.3 s against a search that takes 1 s.
 *
 * The cheap alternative was measured and rejected. Shard directory mtime costs 4 ms
 * for ALL 1,136 shards — 2,575x faster — but it is a proxy: over 60 shards, 18 read
 * older than `imported_at` (safe, over-reports staleness) and 1 read NEWER by 3 hours,
 * which is the direction that says "fresh" about a stale index. A staleness warning
 * that can under-report is worse than none, because it is trusted.
 */
export async function answerFreshness(
  shardDirs: string[], cap = 25,
): Promise<{ lastIndexed: string; ageSec: number; shards: number; sampled: boolean } | null> {
  const dirs = [...new Set(shardDirs)];
  const use = dirs.slice(0, cap);
  let newest = "";
  for (const dir of use) {
    try {
      const f = await (await LanceStore.open(dir)).freshness();
      if (f.lastIndexed > newest) newest = f.lastIndexed;
    } catch { /* an unreadable shard is not a freshness claim */ }
  }
  if (!newest) return null;
  return {
    lastIndexed: newest,
    ageSec: Math.max(0, Math.round((Date.now() - Date.parse(newest)) / 1000)),
    shards: use.length,
    sampled: dirs.length > use.length,
  };
}

export function staleness(row: SessionRow): { behindSec: number; fileMtimeMs: number } | null {
  try {
    const st = statSync(row.file_path);
    const behind = Math.round((st.mtimeMs - Number(row.file_mtime ?? 0) * 1000) / 1000);
    return behind > 60 ? { behindSec: behind, fileMtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}


// ---- Claude Code memory: the join no other source can answer --------------------

export interface MemoryRow {
  repo: string; name: string; memType: string; origin: string;
  ts: string; filePath: string; description: string;
  /** Is the session that produced this memory still in the index? */
  originIndexed: boolean;
}

export interface MemoryReport {
  rows: MemoryRow[];
  total: number;
  byType: { type: string; n: number }[];
  /** Memories carrying an originSessionId at all. */
  withOrigin: number;
  /** Carry an origin, and that session IS indexed — the joinable set. */
  joined: number;
  /** Carry an origin whose session is NOT in the index (pruned, or another machine). */
  orphaned: number;
  perRepo: { repo: string; memories: number; transcripts: number; producing: number }[];
  shards: number;
  ms: number;
}

/**
 * Memories, and how they line up against the transcripts that produced them.
 *
 * `origin_session` is the only key in this index that crosses KINDS — it points from a
 * durable fact back to the conversation that created it. That makes three questions
 * answerable that no other source can answer alone: which sessions produced memories,
 * which memories have outlived their evidence, and how memory density varies by repo.
 *
 * "producing" counts DISTINCT origin sessions present in the shard, not memories, so a
 * session that yielded four facts counts once.
 */
export async function memoryReport(
  s: Scope & { memType?: string; since?: string; until?: string; limit?: number } = {},
): Promise<MemoryReport> {
  const t0 = Date.now();
  const rows: MemoryRow[] = [];
  const byType = new Map<string, number>();
  const perRepo: MemoryReport["perRepo"] = [];
  const since = toISO(s.since);
  const until = toISO(s.until, true);
  let withOrigin = 0, joined = 0, orphaned = 0, shards = 0;

  /*
   * THE JOIN CROSSES BANKS, by construction.
   *
   * A memory is stamped bank `memory`; the session that produced it lives in a
   * `projects*` bank. Those are different shard DIRECTORIES for the same repo, so a
   * per-shard join — read memories and session ids from one store — can only ever
   * report joined=0, orphaned=withOrigin, transcripts=0. Every number would render
   * confidently and every one of them would be wrong.
   *
   * So the transcript side is collected across ALL shards first, and it deliberately
   * ignores `--bank`: narrowing to `memory` leaves no transcripts to join against, and
   * narrowing to `projects` leaves no memories. `--bank` still narrows which MEMORIES
   * are reported.
   */
  const allIds = new Set<string>();
  const txByRepo = new Map<string, number>();
  for (const sh of pickShards({ ...s, bank: undefined })) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const id of await store.sessionIds()) allIds.add(id);
      txByRepo.set(sh.repo, (txByRepo.get(sh.repo) ?? 0) + await store.transcriptCount());
    } catch { /* unreadable shard contributes nothing to the join */ }
  }

  for (const sh of pickShards(s)) {
    let store;
    try { store = await LanceStore.open(sh.dir); } catch { continue; }
    let mems;
    try { mems = await store.memories(); } catch { continue; }
    if (!mems.length) continue;
    shards++;

    const producing = new Set<string>();
    let kept = 0;

    for (const m of mems) {
      if (s.memType && m.mem_type !== s.memType) continue;
      if (since && m.ts && m.ts < since) continue;
      if (until && m.ts && m.ts > until) continue;
      kept++;
      const origin = String(m.origin_session ?? "");
      const originIndexed = Boolean(origin) && allIds.has(origin);
      if (origin) { withOrigin++; originIndexed ? joined++ : orphaned++; }
      if (originIndexed) producing.add(origin);
      const type = String(m.mem_type || "(untyped)");
      byType.set(type, (byType.get(type) ?? 0) + 1);
      rows.push({
        repo: sh.key, name: String(m.session_uuid ?? ""), memType: type, origin,
        ts: String(m.ts ?? ""), filePath: String(m.file_path ?? ""),
        // The description leads the indexed text, so the first line IS the description.
        description: String(m.text ?? "").split("\n")[0].slice(0, 160),
        originIndexed,
      });
    }
    if (kept) perRepo.push({ repo: sh.repo, memories: kept, transcripts: txByRepo.get(sh.repo) ?? 0, producing: producing.size });
  }

  rows.sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));
  perRepo.sort((a, b) => b.memories - a.memories);
  return {
    rows: s.limit ? rows.slice(0, s.limit) : rows,
    total: rows.length,
    byType: [...byType].map(([type, n]) => ({ type, n })).sort((a, b) => b.n - a.n),
    withOrigin, joined, orphaned, perRepo, shards, ms: Date.now() - t0,
  };
}

// ---- what is on disk but NOT in the index ---------------------------------------

export interface PendingGroup {
  source: string; tier: string;
  found: number; indexed: number; changed: number; missing: number;
}
export interface PendingFile {
  path: string; bank: string; source: string; tier: string;
  state: "missing" | "changed";
  mtime: number; size: number;
  sessionId: string;   // "" for shapes that have none (vault notes, memory files)
  repo: string;        // real cwd-derived repo key, or "_unresolved" — see listPending
  // Both read from the transcript, in the SAME parse that resolves `repo` — so they
  // cost nothing extra once a file is being listed at all. A pending report that says
  // "missing 1" without naming it makes the reader go find the file by hand, which is
  // the one thing the report exists to avoid.
  cwd: string;         // the session's own working directory, "" when it wrote none
  name: string;        // its title, or the slash-command it opened with — see nameOf
}
export interface PendingReport {
  groups: PendingGroup[];
  found: number; indexed: number; changed: number; missing: number;
  newestPendingMs: number | null;
  scanMs: number;
  /** Populated only when `list` was asked for. Newest first. */
  files: PendingFile[];
  /** Pending files that exist but were not listed, because `list` capped the output. */
  filesOmitted: number;
  /**
   * Paths discovery could not read (#99). Files under them are in none of the counts
   * above, so "nothing pending" is only true of what the walk could see — this is how
   * a caller that never sees stderr (an MCP client) finds out.
   */
  unreadable: WalkFailure[];
}

/**
 * The session id inside a transcript PATH, without opening the file.
 *
 * Every shape but one buries a uuid somewhere in the path, at a different depth:
 *
 *   <root>/<project>/<uuid>.jsonl                                  claude session
 *   <root>/<project>/<uuid>/subagents/<agent>.jsonl                claude subagent
 *   <root>/<project>/<uuid>/subagents/workflows/wf_R/agent-N.jsonl claude workflow_agent
 *   <root>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl                    codex
 *
 * So the rule is "first uuid anywhere in the path", not "parse the basename" — the
 * basename is the uuid for exactly one of those four, and a subagent file would
 * otherwise report its agent name where a session id belongs.
 *
 * omp has no uuid: `<ts>_<id>.jsonl`, and the id is the part after the underscore.
 * Vault notes and memory files have no session at all, and get "".
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
export function sessionIdOfPath(path: string, source = ""): string {
  const m = UUID_RE.exec(path);
  if (m) return m[0].toLowerCase();
  if (source.startsWith("omp")) {
    const base = path.split("/").pop() ?? "";
    const i = base.indexOf("_");
    if (i >= 0) return base.slice(i + 1).replace(/\.jsonl$/, "");
  }
  return "";
}

/**
 * Discovered-on-disk minus already-imported: the backlog, before an index run.
 *
 * Answers "how many sessions are not indexed" without writing anything, and separates
 * the two reasons a file is pending — never seen (`missing`) versus seen and since
 * modified (`changed`), which is the normal state of every live session.
 *
 * The manifest is the SAME (path, mtime, size) identity the importer skips on, so this
 * cannot disagree with what a real run would do. Manifests are merged across shards
 * because discovery does not know a file's repo until it is parsed — and the encoded
 * project-dir name is lossy, so guessing it here would be wrong for exactly the nested
 * cases that matter.
 */
export async function pendingReport(
  s: Scope & { corpus?: string[] | null; since?: string; list?: number } = {},
): Promise<PendingReport> {
  const t0 = Date.now();
  const seen = new Map<string, { mtime: number; size: number }>();
  for (const sh of pickShards(s)) {
    try {
      const man = await (await LanceStore.open(sh.dir)).manifest();
      for (const [k, v] of man) seen.set(k, v);
    } catch { /* unreadable shard contributes nothing — it just looks unindexed */ }
  }

  const sinceMs = s.since ? parseSince(s.since) : null;
  // `--bank` must narrow BOTH sides. It already narrows the manifest via pickShards
  // above; without the same filter here, discover() returns every source's files and
  // each one counts as `missing` against a manifest that was never asked for them.
  const found = discover(s.corpus ?? null, sinceMs).filter(f => !s.bank || f.bank === s.bank);
  const unreadable = walkFailures();

  const groups = new Map<string, PendingGroup>();
  let indexed = 0, changed = 0, missing = 0, newest: number | null = null;
  const pending: { f: typeof found[number]; state: "missing" | "changed" }[] = [];
  for (const f of found) {
    const k = `${f.source}/${f.tier}`;
    const g = groups.get(k) ?? { source: f.source, tier: f.tier, found: 0, indexed: 0, changed: 0, missing: 0 };
    g.found++;
    const prior = seen.get(f.path);
    if (!prior) { g.missing++; missing++; pending.push({ f, state: "missing" }); }
    else if (prior.mtime !== f.mtime || prior.size !== f.size) { g.changed++; changed++; pending.push({ f, state: "changed" }); }
    else { g.indexed++; indexed++; }
    if (!prior || prior.mtime !== f.mtime || prior.size !== f.size)
      newest = Math.max(newest ?? 0, f.mtime * 1000);
    groups.set(k, g);
  }

  /*
   * THE LIST IS CAPPED AND PARSED; THE COUNTS ARE NEITHER.
   *
   * A file's repo is not knowable from its path — the encoded project-dir name maps
   * both "/" and "." to "-", so two checkouts can share one directory, and deriving a
   * repo from it is a guess that is wrong for exactly the nested worktree cases that
   * send someone looking at this report. So the repo here is read from the transcript's
   * own cwd, which means opening the file.
   *
   * That is why `list` is opt-in and capped: the counts above are a cheap stat() sweep
   * over the whole corpus, and this is N file reads. Sorting by mtime first means the
   * N that get read are the N a human actually asked about — the most recent.
   */
  /*
   * AUTO-LIST WHEN THE SET IS SMALL.
   *
   * `list` was opt-in because listing costs one file read per row. But the common case
   * is a handful of files, where the summary's "missing 1" is exactly the wrong amount
   * of information — it reports that something is missing and makes the reader go find
   * out what. Reading 10 transcripts is milliseconds; reading 30,000 is the reason the
   * cap exists. So: list by default up to AUTO_LIST, and keep the explicit flag for
   * asking past it.
   */
  const AUTO_LIST = 10;
  const cap = s.list === undefined
    ? Math.min(pending.length, AUTO_LIST)
    : Math.max(0, Number(s.list));
  pending.sort((a, b) => b.f.mtime - a.f.mtime);
  const files: PendingFile[] = [];
  for (const { f, state } of pending.slice(0, cap)) {
    let repo = "_unresolved", cwd = "", name = "";
    try {
      const parsed = await f.parser(f.path);
      cwd = parsed.cwd ?? "";
      repo = resolveRepoKey(parsed.cwd) ?? "_unresolved";
      name = nameOf(parsed as { title?: unknown; description?: unknown });
    } catch { /* an unparseable file is exactly why it is still pending — say _unresolved */ }
    files.push({ path: f.path, bank: f.bank, source: f.source, tier: f.tier, state,
                 mtime: f.mtime, size: f.size,
                 sessionId: sessionIdOfPath(f.path, f.source), repo, cwd, name });
  }

  return {
    groups: [...groups.values()].sort((a, b) => (b.missing + b.changed) - (a.missing + a.changed)),
    found: found.length, indexed, changed, missing,
    newestPendingMs: newest, scanMs: Date.now() - t0,
    files, filesOmitted: Math.max(0, pending.length - files.length),
    unreadable,
  };
}
