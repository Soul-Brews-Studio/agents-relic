/**
 * Paths a hit quotes that a temp janitor may already have deleted.
 *
 * The failure this exists for is silent and expensive: relic answers "yes, this was
 * done before" correctly, quotes the exact output paths from the old transcript, and
 * the caller treats them as real. The scratch directory was cleaned up days ago. The
 * job gets redone from scratch, and nothing in the result hinted it would.
 *
 * FLAG AT READ TIME, NEVER AT WRITE TIME. "we downloaded it to /tmp and transcoded it"
 * is exactly what a later session needs to find — the transcript is the record of what
 * happened, and an ephemeral path in it is information, not noise.
 *
 * Measured on bank `projects`, 408,886 events:
 *
 *     reference an ephemeral path:  23,818   (5.8%)
 *       /tmp          8,653
 *       scratchpad    7,755
 *       claude-<pid>  7,410
 *
 * One event in seventeen. Not rare.
 */

/**
 * Two confidence tiers, because they are not the same kind of evidence.
 *
 * STRUCTURAL shapes carry their own proof that a path was session-scoped:
 *   - `/claude-<pid>/`  the pid is IN the path — it cannot outlive that process
 *   - `/scratchpad/`    a directory the tooling itself creates and tears down
 *
 * A bare `/tmp` prefix only CORRELATES. A session legitimately discussing /tmp as a
 * topic, or a daemon configured to keep state there, both match. Same hierarchy as
 * the blob-detection work in #37: prefer the shape that proves itself over the prefix
 * that merely suggests.
 */
export type EphemeralTier = "structural" | "weak";

export interface EphemeralHint {
  tier: EphemeralTier;
  /** What matched, for a message that names the evidence rather than asserting. */
  rule: string;
}

const STRUCTURAL: [RegExp, string][] = [
  // /private/tmp/claude-501/... — the uid/pid segment is the proof.
  [/\/claude-\d+\//, "claude-<pid> scratch root"],
  [/\/scratchpad\//, "scratchpad directory"],
];

// Deliberately anchored at a path boundary: `/tmp` matches, `/var/tmpfiles` does not,
// and the word "tmp" in prose does not.
const WEAK: [RegExp, string][] = [
  [/(?:^|\s|["'`(=])\/(?:private\/)?tmp\//, "/tmp path"],
  [/\$XDG_RUNTIME_DIR\b/, "$XDG_RUNTIME_DIR"],
];

/** The strongest hint in this text, or null. Pure string work — no disk access. */
export function ephemeralHint(text: string): EphemeralHint | null {
  for (const [re, rule] of STRUCTURAL) if (re.test(text)) return { tier: "structural", rule };
  for (const [re, rule] of WEAK) if (re.test(text)) return { tier: "weak", rule };
  return null;
}

/**
 * One line for a hit, or "".
 *
 * Names the MACHINE the path was recorded on, because relic indexes another account's
 * corpus and a second host's (`peer-projects`, 29k files from a peer root). A `stat`
 * from the querying process is meaningless for a path written under a different uid on
 * a different box — without the host, a live check would be wrong rather than merely
 * unhelpful. That is also why there is no live check here: this is pure text.
 */
/**
 * The bank out of a hit's shard key — `<bank>/github.com/<org>/<repo>`.
 *
 * A Hit has NO `bank` field; the bank is the first segment of `repo`. Reaching for
 * `h.bank` compiles, returns undefined, and silently drops the host note on every hit
 * — which is what shipped here first, and which the unit test could not catch because
 * it passed the bank in directly.
 */
export function bankOfHit(repoKey: string): string | undefined {
  const i = repoKey.indexOf("/");
  return i > 0 ? repoKey.slice(0, i) : undefined;
}

export function ephemeralNote(text: string, bank?: string): string {
  const h = ephemeralHint(text);
  if (!h) return "";
  const where = bank && bank !== "projects" ? `, recorded in bank ${bank}` : "";
  return h.tier === "structural"
    ? `  ⚠ ephemeral-path (${h.rule}${where}) — this path was session-scoped and is probably gone`
    : `  · possibly-ephemeral path (${h.rule}${where})`;
}
