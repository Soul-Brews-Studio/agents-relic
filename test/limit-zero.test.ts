import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";
import { BANKS_DIR, DEFAULT_BANK } from "../src/repo.js";

/*
 * #94 — `search --limit 0` must mean "all", not a panic.
 *
 * recap's footer teaches `--limit 0 = all of them`, and recap honours it. `search` sent
 * that same 0 straight into a LanceDB fts topk, whose datafusion operator asserts `k > 0`,
 * so the tokio worker panicked instead of returning everything. This pins the agreed
 * semantics: limit 0 (and negative) returns every match, no throw.
 */
const tmp = mkdtempSync(join(tmpdir(), "relic-limit0-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let uid = 0;
const ev = (text: string) => ({
  uid: `u${uid++}`, session_uuid: "s", file_path: "/f.jsonl", repo_key: "r", seq: 1,
  role: "user", ts: "2026-09-22T00:00:00Z", text,
  source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
});

const dir = join(tmp, BANKS_DIR, DEFAULT_BANK, "github.com", "org", "repo");
mkdirSync(dir, { recursive: true });
const store = await LanceStore.open(dir);
// 25 matches for "discord" — more than the default limit of 20, so "all" is observable.
await store.putEvents(Array.from({ length: 25 }, (_, i) => ev(`discord message number ${i}`)));

describe("search --limit 0 (#94)", () => {
  test("limit 0 does not panic and returns every match (not the default 20)", async () => {
    const hits = await store.search("discord", { limit: 0 });
    expect(hits.length).toBe(25);
  });

  test("a negative limit is treated the same as 0 — all", async () => {
    const hits = await store.search("discord", { limit: -1 });
    expect(hits.length).toBe(25);
  });

  test("a positive limit still caps as before", async () => {
    const hits = await store.search("discord", { limit: 5 });
    expect(hits.length).toBe(5);
  });
});
