import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { defaultRoot } from "./repo.js";
/**
 * tool_result text is capped at 4000 by flattenContent, NOT at MAX_TEXT. The first
 * version of this rule compared against MAX_TEXT (16000) and therefore matched nothing
 * — the proof log is how that was caught, on the first run.
 */
const TOOL_RESULT_CAP = 4000;

/**
 * Which events are not worth indexing, and the proof that the rule was right.
 *
 * The governing principle: THE INDEX POINTS AT CONVERSATION, NOT AT THE FILESYSTEM.
 * When a transcript contains a file's contents, that is a stale copy of something
 * still on disk — searching it finds the act of reading a file rather than the file,
 * and `rg` is better at the file. Measured on one shard, that single class is 34% of
 * all indexed text.
 *
 * #37: as of this change every rule here runs by default (`index --keep-noise` opts
 * back out to the old unfiltered behaviour) and every drop is logged, because a
 * filter you cannot audit is a filter you cannot trust. `relic skipped` reads the
 * log back so a bad rule is visible rather than silent.
 *
 * Deliberately NOT dropped:
 *   - bash commands — "what was that command again" is a real query
 *   - error text in tool_result — often the whole reason for searching
 *   - any prose: user, assistant, thinking
 */

export interface NoiseVerdict { skip: boolean; rule: string }

/**
 * #37 — is there an unbroken run of at least 120 non-whitespace characters anywhere
 * in the text? Whitespace codes only (space/tab/nl/cr/vt/ff) — punctuation inside a
 * token does not break the run, which is the point: a JWT's three dot-joined base64url
 * segments, a hex digest, and a minified-JS line are each one unbroken token even
 * though none of them are pure base64.
 *
 * Replaces the old `binary-blob` rule's regex, `/[A-Za-z0-9+\/]{120,}={0,2}/`, which
 * only caught the base64 alphabet. Benchmarked in #37 on 20,000 events / 12.7 MB:
 *
 *   longest-run >= 120      21 ms   617 MB/s   flagged 2,076
 *   base64 regex (old)      57 ms   225 MB/s   flagged    64
 *   shannon entropy        133 ms    95 MB/s   flagged 1,972  (worst: 6x slower, prose
 *                                                              and tool-traffic entropy
 *                                                              medians overlap 4.2-4.9)
 *
 * This is NOT the same predicate as the old regex — it is both faster (single pass,
 * no backtracking) AND broader (2,076 vs 64 on that corpus, a ~32x increase in this
 * rule's own catch). The delta is deliberate, not a silent regression: the rule's
 * comment below ("matches nothing a human would type") applies just as well to a JWT
 * or a hex digest as it does to base64, and catching them is the whole reason to
 * prefer this tier over the regex it replaces. See PR for measurements on real data.
 */
function longestUnbrokenRun(t: string): number {
  let max = 0, run = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    // space, tab, \n, \v, \f, \r
    if (c === 32 || (c >= 9 && c <= 13)) run = 0;
    else if (++run > max) max = run;
  }
  return max;
}

/*
 * NAMED ENCODINGS, NOT A LENGTH TEST — with the length test kept as a prefilter.
 *
 * "An unbroken run of >= 120 non-whitespace characters" is not a blob test, it is a
 * length test, and on real transcripts the things that clear 120 characters without a
 * space are mostly content: deep ghq paths, one-line JSON tool results, `rg` command
 * lines, lsof output. Measured on 7,067 real events from this machine:
 *
 *   old base64 regex                    14
 *   run >= 120 alone                   678      <- 664 of them real content
 *   named shapes (this)                 14      <- same 14, zero new false positives
 *   named shapes + base64url           16      <- the 2 extras were both content
 *
 * base64url is deliberately NOT in the list. Its alphabet ([A-Za-z0-9_-]) is ordinary
 * path and identifier text, so it flagged a measurement table and a filename dump.
 * A noise rule DELETES data from the index, so a false positive costs more than a
 * miss: precision over recall, and each alternative here has to name an encoding.
 *
 * The run check survives as a PREFILTER. It is single-pass and ~20x faster than the
 * regexes (21 ms vs 57 ms per #37's benchmark on 20k events), and nothing in the list
 * below can match without a 120-character unbroken run existing first — so the cheap
 * pass rejects almost everything and the expensive one only sees candidates.
 */
const BLOB_SHAPES: RegExp[] = [
  /[A-Za-z0-9+/]{120,}={0,2}/,                       // base64 body
  /\b[0-9a-fA-F]{120,}\b/,                           // hex digest, binary as hex
  // {10,} for the header, not {20,}: a minimal real header — eyJhbGciOiJIUzI1NiJ9,
  // i.e. {"alg":"HS256"} — is only 17 characters after the eyJ, and the first version
  // of this pattern missed it. The payload segment is what carries the length.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}\./,   // JWT: header.payload.
  /\bdata:[a-z.+-]+\/[a-z.+-]+;base64,/i,            // data: URI
];

export function isBlob(t: string): boolean {
  if (longestUnbrokenRun(t) < 120) return false;     // cheap pass first
  return BLOB_SHAPES.some(re => re.test(t));
}

export { BLOB_SHAPES };

/** Three consecutive ascending integers used as line numbers — a file dump's tell. */
function hasNumberedLines(t: string): boolean {
  const nums: number[] = [];
  for (const m of t.matchAll(/(?:^|\n|\s)(\d{1,5})(?:→|\t| )/g)) {
    nums.push(Number(m[1]));
    if (nums.length > 400) break;
  }
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    run = nums[i] === nums[i - 1] + 1 ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

const RULES: { rule: string; test: (text: string, role: string) => boolean }[] = [
  {
    /**
     * A file read into the transcript, detected by its LINE NUMBERING — not by length.
     *
     * The first version dropped every tool_result at the 4000-char cap, which is what
     * the analysis predicted would reclaim 34% of the index. Auditing the proof log
     * showed it also ate a session-dig result and a metrics table: long output that
     * exists nowhere else. Length is not a proxy for worthlessness.
     *
     * The real signature is three consecutive ascending line numbers, which a file
     * dump has and prose, tables and command output do not.
     */
    rule: "file-readback",
    test: (t, role) => role === "tool_result" && t.length > 500 && hasNumberedLines(t),
  },
  {
    // The payload duplicates a file that now exists on disk in its final form.
    rule: "edit-payload",
    test: (t) => /^\[tool_use (Edit|Write|MultiEdit|NotebookEdit)\]/.test(t),
  },
  {
    // "[tool_use Read] {"file_path":"..."}" — an intent to read, with no content.
    rule: "navigation-call",
    test: (t) => /^\[tool_use (Read|Glob|LS|Grep|TodoWrite)\]/.test(t),
  },
  {
    // Matches nothing a human would type, but every token enters the FTS index.
    // See longestUnbrokenRun() above for why 120 unbroken chars, not the base64
    // alphabet, is the test.
    rule: "binary-blob",
    test: (t) => isBlob(t),
  },
  {
    // Anchored and specific ON PURPOSE. The first version matched /token.?usage/i
    // anywhere in the text and swallowed a tool_result containing the source of a
    // TOKENIZER file — real content I had asked for. A noise rule that matches on a
    // common word will eat the thing you were searching for.
    rule: "harness-bookkeeping",
    test: (t) => /^\[tool_result\]\s*<system-reminder>/.test(t)
              || /^\[tool_result\]\s*\{"total_tokens"/.test(t),
  },
];

export function classify(text: string, role: string): NoiseVerdict {
  // Prose is never noise, whatever it contains.
  if (role === "user" || role === "assistant" || role === "thinking" || role === "system")
    return { skip: false, rule: "" };
  for (const r of RULES) if (r.test(text, role)) return { skip: true, rule: r.rule };
  return { skip: false, rule: "" };
}

export function skippedPath(dataRoot: string | null): string {
  return join(dataRoot ?? defaultRoot(), "skipped.jsonl");
}

/** The proof log: one line per dropped event, enough to judge the rule by. */
export function logSkipped(
  rows: { uid: string; file_path: string; seq: number; role: string; rule: string; bytes: number; head: string }[],
  dataRoot: string | null,
): void {
  if (!rows.length) return;
  try {
    const p = skippedPath(dataRoot);
    mkdirSync(dirname(p), { recursive: true });
    // One write() for the whole batch — this fleet has two separate incidents of a
    // JSONL log corrupting under concurrent append built from multiple writes.
    appendFileSync(p, rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  } catch { /* an unwritable proof log must not fail an index run */ }
}

export interface SkipStats {
  total: number;
  bytes: number;
  byRule: { rule: string; n: number; bytes: number }[];
  samples: { rule: string; head: string; bytes: number; file_path: string; seq: number }[];
}

export function readSkipped(dataRoot: string | null, samplesPerRule = 2): SkipStats | null {
  const p = skippedPath(dataRoot);
  if (!existsSync(p)) return null;
  const agg = new Map<string, { n: number; bytes: number }>();
  const samples: SkipStats["samples"] = [];
  const seen = new Map<string, number>();
  let total = 0, bytes = 0;

  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    total++; bytes += Number(r.bytes ?? 0);
    const a = agg.get(r.rule) ?? { n: 0, bytes: 0 };
    a.n++; a.bytes += Number(r.bytes ?? 0); agg.set(r.rule, a);
    const c = seen.get(r.rule) ?? 0;
    if (c < samplesPerRule) {
      samples.push({ rule: r.rule, head: String(r.head ?? ""), bytes: Number(r.bytes ?? 0),
                     file_path: String(r.file_path ?? ""), seq: Number(r.seq ?? 0) });
      seen.set(r.rule, c + 1);
    }
  }
  if (!total) return null;
  return {
    total, bytes,
    byRule: [...agg].map(([rule, a]) => ({ rule, ...a })).sort((x, y) => y.bytes - x.bytes),
    samples,
  };
}
