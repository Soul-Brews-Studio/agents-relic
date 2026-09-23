import { Index } from "@lancedb/lancedb";

// ICU first; `simple` only when this LanceDB build has no ICU (#63), and recorded, since `simple` finds 1 of 12 Thai substrings (#33).

export type Tokenizer = "icu" | "simple";

/** The fallback's index NAME is the per-shard record: it travels with the index and cannot drift from it. */
export const SIMPLE_INDEX = "text_fts_simple";

export interface FtsTable {
  listIndices(): Promise<{ name: string; columns: string[] }[]>;
  createIndex(column: string, options?: { config?: Index; replace?: boolean; name?: string }): Promise<void>;
  dropIndex(name: string): Promise<void>;
}

export interface FtsOutcome {
  tokenizer: Tokenizer;   // what the shard's index uses after this call
  built: boolean;         // this call wrote an index
  upgraded?: boolean;     // a `simple` index was replaced by ICU
  fellBack?: string;      // the error that refused ICU
}

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

    // Long identifiers and 64-char hashes must survive whole.
    maxTokenLength: 128,
  });
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
  const names = await onText(t);
  const simple = names.includes(SIMPLE_INDEX);
  const icu = names.some(n => n !== SIMPLE_INDEX);

  if (icu && !opts.rebuild) {
    if (simple) await t.dropIndex(SIMPLE_INDEX);   // an upgrade interrupted between create and drop
    return { tokenizer: "icu", built: false };
  }
  try {
    await t.createIndex("text", { config: config("icu"), replace: true });
  } catch (err) {
    if (!noIcu(err)) throw err;
    if (simple && !opts.rebuild) return { tokenizer: "simple", built: false, fellBack: String(err) };
    await t.createIndex("text", { config: config("simple"), name: SIMPLE_INDEX, replace: true });
    return { tokenizer: "simple", built: true, fellBack: String(err) };
  }
  // ICU first, THEN drop the fallback, so a failed upgrade never leaves the shard with no index.
  if (simple) await t.dropIndex(SIMPLE_INDEX);
  return { tokenizer: "icu", built: true, upgraded: simple };
}
