import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";
import { answerFreshness } from "../src/query.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-fresh-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const fi = (file_path: string, imported_at: string) =>
  ({ file_path, repo_key: "r", mtime: 1, size: 2, imported_at });

async function shard(name: string, stamps: string[]) {
  const s = await LanceStore.open(join(tmp, name));
  await s.putFiles(stamps.map((t, i) => fi(`/f${i}`, t)));
  return join(tmp, name);
}

describe("answerFreshness — how old is the index behind THIS answer", () => {
  /*
   * A ranked list from a stale index is worse than an empty one: confident,
   * relevant-looking, and silently scoped to whatever happened to be indexed.
   *
   * Scoped to the shards that produced HITS. freshness() full-scans two columns per
   * shard — 9.1 ms measured — so all 1,136 shards would cost 10.3 s against a 1 s
   * search. Over hit shards it measured 92 ms, 2.3% overhead.
   */
  test("reports the NEWEST import across the shards that answered", async () => {
    const a = await shard("a", ["2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z"]);
    const b = await shard("b", ["2026-09-05T00:00:00.000Z"]);
    const f = (await answerFreshness([a, b]))!;
    expect(f.lastIndexed).toBe("2026-09-10T00:00:00.000Z");
    expect(f.shards).toBe(2);
  });

  test("age is derived from that newest stamp", async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const f = (await answerFreshness([await shard("recent", [recent])]))!;
    expect(f.ageSec).toBeGreaterThan(3500);
    expect(f.ageSec).toBeLessThan(3700);
  });

  test("duplicate shard dirs are counted once", async () => {
    const a = await shard("dup", ["2026-09-01T00:00:00.000Z"]);
    expect((await answerFreshness([a, a, a]))!.shards).toBe(1);
  });

  test("an unreadable shard is not a freshness CLAIM", async () => {
    // Silently treating a failed read as "fresh" is the direction that makes a
    // staleness warning worse than none — it would be trusted.
    const a = await shard("real", ["2026-09-01T00:00:00.000Z"]);
    const f = (await answerFreshness([a, join(tmp, "does-not-exist")]))!;
    expect(f.lastIndexed).toBe("2026-09-01T00:00:00.000Z");
  });

  test("no shards, or none with stamps, yields null rather than a fake age", async () => {
    expect(await answerFreshness([])).toBeNull();
    expect(await answerFreshness([join(tmp, "nope")])).toBeNull();
  });

  test("the cap bounds the cost and SAYS it sampled", async () => {
    // 9.1 ms/shard is affordable over hits and not over a corpus; the caller must be
    // able to tell a capped answer from a complete one.
    const dirs = [];
    for (let i = 0; i < 5; i++) dirs.push(await shard(`c${i}`, ["2026-09-0" + (i + 1) + "T00:00:00.000Z"]));
    const f = (await answerFreshness(dirs, 2))!;
    expect(f.shards).toBe(2);
    expect(f.sampled).toBe(true);
    expect((await answerFreshness(dirs, 99))!.sampled).toBe(false);
  });
});
