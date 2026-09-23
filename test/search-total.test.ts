import { expect, test, describe, afterAll, beforeAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LanceStore } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import { searchEvents, matchCount, floorNote } from "../src/query.js";

/*
 * #95. "N of M match(es)" drew M from the pool the shards returned, and each shard is
 * asked for its own top `limit` — so M measured the fetch, not the corpus. On the real
 * index one query read "1 of 640" at --limit 1 and "400 of 53892" at --limit 400; every
 * match is 171,790. M is now a count only when no shard held more than it was asked
 * for, and says "at least" when one did.
 */

const tmp = mkdtempSync(join(tmpdir(), "relic-total-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const root = join(tmp, "root");

/*
 * Two shards of five matches each, every one with its own score: equal-length docs
 * with a different `needle` count each, so no two rows tie and nothing here depends
 * on how ties break. (BM25 is per index, so the two shards interleave by their own
 * statistics — the order is whatever the engine says, not 10, 9, 8 … 1.)
 */
const ev = (shard: string, tf: number) => ({
  uid: `${shard}${tf}`, session_uuid: "s1", file_path: `/x/${shard}.jsonl`, repo_key: `github.com/o/${shard}`,
  seq: tf, role: "user", ts: `2026-09-23T00:00:${String(tf).padStart(2, "0")}.000Z`,
  text: [...Array(tf).fill("needle"), ...Array(12 - tf).fill("hay")].join(" "),
  source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "/x",
  org: "o", project: "", dir: "", mem_type: "", origin_session: "",
});

beforeAll(async () => {
  for (const [shard, tfs] of [["a", [10, 8, 6, 4, 2]], ["b", [9, 7, 5, 3, 1]]] as const) {
    const st = await LanceStore.open(shardDirFor(`github.com/o/${shard}`, root));
    await st.putEvents(tfs.map(tf => ev(shard, tf)));
    await st.ensureFtsIndex();
  }
});

const search = (limit: number) => searchEvents("needle", { dataRoot: root, limit, warnGeneric: false });

describe("searchEvents — whether the total is a count", () => {
  test("every shard read to the end: the total is every match, whatever the limit", async () => {
    for (const limit of [0, 5, 6, 50]) {
      const r = await search(limit);
      expect([limit, r.capped, r.total]).toEqual([limit, 0, 10]);
    }
  });

  test("a shard with exactly `limit` matches is not capped — the probe row says so", async () => {
    // Without it, 5 rows back from a limit of 5 cannot tell "all of them" from "the first 5".
    expect((await search(5)).capped).toBe(0);
  });

  test("capped shards make the total a floor, below the real count", async () => {
    const r = await search(2);
    expect(r.capped).toBe(2);
    expect(r.total).toBeLessThan(10);
    expect(r.total).toBeGreaterThan(2);
  });

  test("the probe row never changes what is shown", async () => {
    const every = (await search(0)).hits.map(h => h.uid);
    expect(new Set(every).size).toBe(10);
    for (const limit of [1, 2, 3, 4]) {
      const r = await search(limit);
      expect(r.hits.slice(0, limit).map(h => h.uid)).toEqual(every.slice(0, limit));
    }
  });

  test("the probe cannot wrap the native u32 to 0", async () => {
    // LanceDB takes the limit as a u32: 4294967295 + 1 would arrive as 0, #94's panic.
    expect(await search(2 ** 32 - 1)).toMatchObject({ total: 10, capped: 0 });
  });
});

describe("matchCount / floorNote — the header's words", () => {
  test("a count reads as one; a floor says so", () => {
    expect(matchCount(20, 129)).toBe("20 of 129");
    expect(matchCount(20, 129, 0)).toBe("20 of 129");
    expect(matchCount(20, 8620, 488)).toBe("20 of at least 8620");
  });

  test("the note exists only for a floor, and names what was not read", () => {
    expect(floorNote(0, 1141, 20)).toBeNull();
    expect(floorNote(undefined, 1141, 20)).toBeNull();
    expect(floorNote(488, 1141, 20)).toBe(
      "a floor, not a count — 488 of 1141 shards hold more than 20 matches and were not read to the end");
    expect(floorNote(3, 9, 1)).toContain("more than 1 match and");
  });
});

describe("both surfaces say it", () => {
  const cli = (...args: string[]) => {
    const p = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "search", "needle", ...args,
                             "--data-root", root], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RELIC_NO_TRACE: "1" } });
    return p.stdout.toString();
  };

  test("CLI header, note and --json", () => {
    const capped = cli("--limit", "2").split("\n");
    expect(capped[0]).toMatch(/^2 of at least \d+ match\(es\) for needle · 2 shards/);
    expect(capped[1]).toBe("  a floor, not a count — 2 of 2 shards hold more than 2 matches and were not " +
                           "read to the end. --limit 0 reads every match.");
    expect(cli("--limit", "5")).toStartWith("5 of 10 match(es) for needle");
    expect(cli("--limit", "5")).not.toContain("a floor, not a count");

    const j = (limit: string) => JSON.parse(cli("--limit", limit, "--json"));
    expect([j("2").exhaustive, j("2").capped]).toEqual([false, 2]);
    expect([j("5").exhaustive, j("5").capped, j("5").total]).toEqual([true, 0, 10]);
  }, 30_000);   // spawns the CLI twice; 5 s bun default flaked at 5.36 s under a full suite

  /*
   * The MCP server in its own process, over stdio, as a model reaches it. It reads
   * RELIC_DATA_ROOT once at import, so importing it here would bind whatever root the
   * first importer had — serve.test.ts imports it through serve.ts.
   */
  test("MCP header and note — and limit:0 lists every hit, as the note says", async () => {
    const client = new Client({ name: "search-total-test", version: "0" });
    await client.connect(new StdioClientTransport({
      command: "bun", args: [join(import.meta.dir, "..", "src", "mcp.ts")], stderr: "pipe",
      env: { ...process.env, RELIC_DATA_ROOT: root, RELIC_NO_TRACE: "1" } as Record<string, string>,
    }));
    const search = async (limit: number) => {
      const r = await client.callTool({ name: "relic_search", arguments: { query: "needle", limit } });
      return (r.content as { text: string }[])[0].text;
    };
    try {
      const capped = (await search(2)).split("\n");
      expect(capped[0]).toMatch(/^2 of at least \d+ matches · 2 shards/);
      expect(capped[1]).toBe("a floor, not a count — 2 of 2 shards hold more than 2 matches and were not " +
                             "read to the end. limit:0 reads every match — pass repo with it.");
      const exact = (await search(5)).split("\n");
      expect(exact[0]).toStartWith("5 of 10 matches");
      expect(exact[1]).toBe("");
      // #107 made the store return every match for 0; this header used to slice it to "0 of 10".
      const every = await search(0);
      expect(every).toStartWith("10 of 10 matches");
      expect(every.match(/relic_show {2}file=/g)).toHaveLength(10);
    } finally {
      await client.close();
    }
  });
});
