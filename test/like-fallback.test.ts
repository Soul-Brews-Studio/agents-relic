import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";

/**
 * Issue #71. With no FTS index (a fresh shard, or #63's failed ICU build) search falls
 * back to a LIKE scan, which was case-sensitive: `air4thai` found 0 of the rows that
 * `Air4Thai` found, while the FTS path it stands in for matches either.
 */

const tmp = mkdtempSync(join(tmpdir(), "relic-like-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ev = (uid: string, text: string) => ({
  uid, session_uuid: "s", file_path: "/a.jsonl", repo_key: "r", seq: 1, role: "user", ts: "", text,
  source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
  org: "", project: "", dir: "", mem_type: "", origin_session: "",
});

describe("LIKE fallback (no FTS index)", () => {
  test("matches regardless of case", async () => {
    const s = await LanceStore.open(join(tmp, "case"));
    await s.putEvents([ev("u1", "deploy Air4Thai sensors"), ev("u2", "unrelated")]);
    for (const q of ["air4thai", "Air4Thai", "AIR4THAI"])
      expect((await s.search(q)).map(h => h.uid)).toEqual(["u1"]);
  });

  test("a quote in the query is still escaped", async () => {
    const s = await LanceStore.open(join(tmp, "quote"));
    await s.putEvents([ev("u1", "Nat's board"), ev("u2", "boards")]);
    expect((await s.search("NAT'S")).map(h => h.uid)).toEqual(["u1"]);
  });
});
