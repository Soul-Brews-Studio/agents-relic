import { expect, test, describe } from "bun:test";

/*
 * Two counting bugs found by putting relic's own numbers on a status board and reading
 * them. Both are about the same confusion — a transcript is a FILE, a conversation is a
 * TREE of them — and both were wrong in a direction that overstates.
 */

/** What groupTranscripts does, reduced to its key choice. */
const group = (rows: { repo: string; session_uuid: string; file_path?: string }[],
               byPair: boolean) =>
  new Set(rows.map(r => (r.session_uuid
    ? (byPair ? `${r.repo}\u0000${r.session_uuid}` : r.session_uuid)
    : r.file_path ?? ""))).size;

describe("grouping key — (repo, session_uuid), not the uuid alone", () => {
  /*
   * The same uuid appears under a resolved repo AND under `_unresolved` when part of a
   * tree was indexed before its cwd could be attributed. Keying on the uuid merges
   * those into one row and loses a real tree. Measured on the live index the day this
   * was written: 373 distinct uuids, 376 distinct pairs — 3 trees silently merged.
   */
  const rows = [
    { repo: "laris-co/neo-oracle", session_uuid: "a" },
    { repo: "_unresolved",         session_uuid: "a" },   // same uuid, different repo
    { repo: "laris-co/neo-oracle", session_uuid: "b" },
  ];

  test("the pair key keeps both halves of a split tree", () => {
    expect(group(rows, true)).toBe(3);
  });

  test("the uuid-only key merges them — the bug", () => {
    expect(group(rows, false)).toBe(2);
  });

  test("a row with no uuid falls back to its path rather than colliding on empty", () => {
    const odd = [
      { repo: "r", session_uuid: "", file_path: "/a.jsonl" },
      { repo: "r", session_uuid: "", file_path: "/b.jsonl" },
    ];
    expect(group(odd, true)).toBe(2);
  });
});

describe("transcripts are not sessions", () => {
  /*
   * ShardStat.sessions counts ROWS in the sessions table — one per transcript. On the
   * live index that read 1,790 while the real conversation count was 323: a 5.5x
   * overstatement, rendered under the word "sessions" on a status board.
   */
  const tiers = [
    ...Array(325).fill("session"),
    ...Array(616).fill("subagent"),
    ...Array(849).fill("workflow_agent"),
  ];

  test("the row count is transcripts across every tier", () => {
    expect(tiers.length).toBe(1790);
  });

  test("session-tier rows are a fraction of it — labelling them the same overstates 5x", () => {
    const sessions = tiers.filter(t => t === "session").length;
    expect(sessions).toBe(325);
    expect(tiers.length / sessions).toBeGreaterThan(5);
  });
});
