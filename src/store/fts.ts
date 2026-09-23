import { Index } from "@lancedb/lancedb";

// ICU first; `simple` only when this LanceDB build has no ICU (#63), and recorded, since `simple` finds 1 of 12 Thai substrings (#33).

export type Tokenizer = "icu" | "simple";

/** The fallback's index NAME is the per-shard record: it travels with the index and cannot drift from it. */
export const SIMPLE_INDEX = "text_fts_simple";

export interface FtsTable {
  listIndices(): Promise<{ name: string; columns: string[]; indexDetails?: unknown }[]>;
  createIndex(column: string, options?: { config?: Index; replace?: boolean; name?: string }): Promise<void>;
  dropIndex(name: string): Promise<void>;
}

export interface FtsOutcome {
  tokenizer: Tokenizer;   // what the shard's index uses after this call
  built: boolean;         // this call wrote an index
  upgraded?: boolean;     // a `simple` index was replaced by ICU
  drifted?: boolean;      // the index it replaced was built with other stop-word settings (#97)
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

/** Only this error means "no ICU in this build"; anything else is a real failure and must surface. */
export const noIcu = (err: unknown) => /unknown base tokenizer/i.test(String(err));

const onText = async (t: Pick<FtsTable, "listIndices">) =>
  (await t.listIndices()).filter(i => i.columns.includes("text")).map(i => i.name);

/** Which tokenizer a shard's index uses — null when it has no full-text index at all. */
export async function tokenizerOf(t: Pick<FtsTable, "listIndices">): Promise<Tokenizer | null> {
  const names = await onText(t);
  if (!names.length) return null;
  return names.some(n => n !== SIMPLE_INDEX) ? "icu" : "simple";
}

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

  if (icu && !opts.rebuild && !staleIcu) {
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
    if (simple && !opts.rebuild && !staleSimple) return { tokenizer: "simple", built: false, fellBack: String(err) };
    await t.createIndex("text", { config: config("simple"), name: SIMPLE_INDEX, replace: true });
    return { tokenizer: "simple", built: true, fellBack: String(err), ...(staleSimple && { drifted: true }) };
  }
  // ICU first, THEN drop the fallback, so a failed upgrade never leaves the shard with no index.
  if (simple) await t.dropIndex(SIMPLE_INDEX);
  return { tokenizer: "icu", built: true, upgraded: Boolean(simple), ...(staleIcu && { drifted: true }) };
}
