import { Index } from "@lancedb/lancedb";

// ICU first; `simple` only when this LanceDB build has no ICU (#63), and recorded, since `simple` finds 1 of 12 Thai substrings (#33).

export type Tokenizer = "icu" | "simple";

/** The fallback's index NAME is the per-shard record: it travels with the index and cannot drift from it. */
export const SIMPLE_INDEX = "text_fts_simple";

/** One index as listIndices() reports it — the fields this module reads. */
export interface FtsIndexInfo {
  name: string;
  columns: string[];
  indexDetails?: unknown;
  numIndexedRows?: number;
  numUnindexedRows?: number;
}

export interface FtsTable {
  listIndices(): Promise<FtsIndexInfo[]>;
  createIndex(column: string, options?: { config?: Index; replace?: boolean; name?: string }): Promise<void>;
  dropIndex(name: string): Promise<void>;
}

export interface FtsOutcome {
  tokenizer: Tokenizer;   // what the shard's index uses after this call
  built: boolean;         // this call wrote an index
  upgraded?: boolean;     // a `simple` index was replaced by ICU
  drifted?: boolean;      // the index it replaced was built with other stop-word settings (#97)
  covered?: number;       // rows appended since the old index was built, now inside the new one (#115)
  fellBack?: string;      // the error that refused ICU
}

/** What ftsConfig() writes into every index, and what drifted() reads back. */
export const REMOVE_STOP_WORDS = false;

export function ftsConfig(tokenizer: Tokenizer): Index {
  return Index.fts({
    baseTokenizer: tokenizer,

    // stem:false — this is a CODE corpus, and the English stemmer mangles identifiers.
    // Proven with table.tokenize():
    //   stem:true    structured_output_mode -> structured_output_mod
    //                CLAUDE_..._AGENT_TEAMS -> claude_..._agent_team
    //   stem:false   both exact
    // The cost is that `sessions` no longer matches `session`. That is the right
    // trade here: a 3,000-event sample held 354 distinct identifiers over 21 chars
    // (env vars, git SHAs, index names), and searching for a precise identifier is
    // the common case — searching for an English plural is not.
    stem: false,

    // removeStopWords:false — LanceDB's default is true, and under ICU that is NOT an
    // English list. With no custom list and base tokenizer icu, lance 12 filters
    // StopWordFilter::all(): 21 languages at once, 5,200 words, `language: "English"`
    // ignored. So `nas` (Portuguese), `na`, `bin`/`dir`/`mit` (German), `min`/`var`
    // (Scandinavian), `del`, `com` and `num` never reached the index (#97). The query
    // tokenized to nothing, FTS answered [] without an error — so the LIKE fallback never
    // ran either. Measured on a 1,136-shard index: `nas` 0 rows before, 9,971 after a
    // rebuild with this line; `bin` 0 -> 267,157. A CODE corpus is made of words like
    // these, and BM25 already discounts common words (idf), so there is nothing to filter.
    // relicpy has built with remove_stop_words=False since it was written, and bench/
    // measured with it; this line is parity with both.
    removeStopWords: REMOVE_STOP_WORDS,

    // Long identifiers and 64-char hashes must survive whole.
    maxTokenLength: 128,
  });
}

/**
 * An index built with a different stop-word setting than ftsConfig() writes today — every
 * shard built before #97. Stale, not broken: it still answers, minus every word it dropped,
 * which is why nothing else notices. No `indexDetails`, or no field in it, is UNKNOWN, not
 * drift: only an explicit rebuild (`relic index --fts-rebuild`) replaces what cannot say
 * how it was built.
 */
export function drifted(details: unknown): boolean {
  const removed = (details as { remove_stop_words?: unknown } | null | undefined)?.remove_stop_words;
  return typeof removed === "boolean" && removed !== REMOVE_STOP_WORDS;
}

/** Rows an index does not cover yet — appended after it was built. 0 when it does not say. */
export const gapOf = (i?: FtsIndexInfo) => i?.numUnindexedRows ?? 0;

/*
 * #115: AN INDEX IS BUILT ONCE, AND EVERY ROW APPENDED AFTER THAT SITS OUTSIDE IT.
 *
 * LanceDB still finds those rows — by tokenizing each one again on every search — so answers
 * stay right while the shard gets slower with every import, which is why nothing noticed.
 * Measured before this existed: 437,574 rows (7.1%) in 85 shards were outside their index,
 * and homelab's index covered the 12 rows the shard held when it was built, of 88,922.
 *
 * WHY A THRESHOLD RE-INDEX AND NOT optimize(). Measured on an APFS clone of every bank (1,142
 * shards, 6.2M rows) after one real `relic index` run, which left 28,257 rows in 43 shards
 * outside their index:
 *   optimize() on all 43        18.2 s wall  20.3 s cpu  +1,386 MB   gap -> 0
 *   re-index all 43             29.3 s wall  62.8 s cpu    +291 MB   gap -> 0
 *   re-index where behind()      6.0 s wall  14.6 s cpu     +39 MB   3 shards; 9,534 rows (0.15%) wait
 * optimize() also compacts the data files and prunes old versions; that is where the disk goes,
 * and it is a second, bigger write than the one this needs. The rows below the threshold are
 * still found, and `relic status` counts them.
 */
export const COVER_FRACTION = 0.05;
export const COVER_MIN_ROWS = 1_000;

/** The gap is big enough to rebuild for: COVER_FRACTION of the shard, and at least COVER_MIN_ROWS. */
export function behind(i?: FtsIndexInfo): boolean {
  const gap = gapOf(i);
  return gap >= COVER_MIN_ROWS && gap >= COVER_FRACTION * (gap + (i?.numIndexedRows ?? 0));
}

/** Only this error means "no ICU in this build"; anything else is a real failure and must surface. */
export const noIcu = (err: unknown) => /unknown base tokenizer/i.test(String(err));

/**
 * Which tokenizer a shard's index uses — null when it has no full-text index at all — and how many
 * of its rows that index does not cover (#115). One listIndices call answers both.
 */
export async function ftsStateOf(t: Pick<FtsTable, "listIndices">): Promise<{ tokenizer: Tokenizer | null; unindexed: number }> {
  const text = (await t.listIndices()).filter(i => i.columns.includes("text"));
  const icu = text.find(i => i.name !== SIMPLE_INDEX);
  if (!text.length) return { tokenizer: null, unindexed: 0 };
  return { tokenizer: icu ? "icu" : "simple", unindexed: gapOf(icu ?? text[0]) };
}

export const tokenizerOf = async (t: Pick<FtsTable, "listIndices">) => (await ftsStateOf(t)).tokenizer;

// `config` is injectable so the fallback is testable where LanceDB does have ICU.
export async function ensureFtsIndex(
  t: FtsTable, opts: { rebuild?: boolean } = {}, config: (tok: Tokenizer) => Index = ftsConfig,
): Promise<FtsOutcome> {
  const text = (await t.listIndices()).filter(i => i.columns.includes("text"));
  const simple = text.find(i => i.name === SIMPLE_INDEX);
  const icu = text.find(i => i.name !== SIMPLE_INDEX);
  // #97: an index built with other stop-word settings is rebuilt as if asked to. Without this an
  // existing index returns early below, so a changed ftsConfig() never reaches a shard built before it.
  const staleIcu = Boolean(icu && drifted(icu.indexDetails));
  const staleSimple = Boolean(simple && drifted(simple.indexDetails));
  // #115: and so is one that no longer covers enough of its shard — see behind().
  const icuBehind = behind(icu), simpleBehind = behind(simple);

  if (icu && !opts.rebuild && !staleIcu && !icuBehind) {
    if (simple) await t.dropIndex(SIMPLE_INDEX);   // an upgrade interrupted between create and drop
    return { tokenizer: "icu", built: false };
  }
  try {
    await t.createIndex("text", { config: config("icu"), replace: true });
  } catch (err) {
    if (!noIcu(err)) throw err;
    // Never ICU -> `simple`. An ICU index here was built where ICU loads; a `simple` one beside it
    // would leave two full-text indexes on one column. It is kept, stale or not, until ICU loads.
    if (icu) return { tokenizer: "icu", built: false, fellBack: String(err) };
    if (simple && !opts.rebuild && !staleSimple && !simpleBehind)
      return { tokenizer: "simple", built: false, fellBack: String(err) };
    await t.createIndex("text", { config: config("simple"), name: SIMPLE_INDEX, replace: true });
    return { tokenizer: "simple", built: true, fellBack: String(err),
             ...(staleSimple && { drifted: true }), ...(gapOf(simple) && { covered: gapOf(simple) }) };
  }
  // ICU first, THEN drop the fallback, so a failed upgrade never leaves the shard with no index.
  if (simple) await t.dropIndex(SIMPLE_INDEX);
  return { tokenizer: "icu", built: true, upgraded: Boolean(simple),
           ...(staleIcu && { drifted: true }), ...(gapOf(icu) && { covered: gapOf(icu) }) };
}
