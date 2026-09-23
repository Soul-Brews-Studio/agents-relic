import { expect, test, describe, afterAll } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFtsIndex, ftsConfig, behind, gapOf, COVER_FRACTION, COVER_MIN_ROWS, SIMPLE_INDEX,
         type FtsIndexInfo, type Tokenizer } from "../src/store/fts.js";
import { importFiles } from "../src/import.js";
import { shardDirFor } from "../src/repo.js";
import { indexStatus, coverageNote } from "../src/query.js";
import type { Found } from "../src/discover.js";

/*
 * Issue #115: an FTS index was built once and never extended. Every row a later import
 * appended sat outside it, found only by re-tokenizing it on every search — 437,574 rows in
 * 85 shards on one machine. These pin that an import run brings the index back over its
 * shard, and that status says how many rows are outside it.
 */
const tmp = mkdtempSync(join(tmpdir(), "relic-coverage-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu, tokenizer.rs:340:17";
const noIcu = (tok: Tokenizer) => { if (tok === "icu") throw new Error(REFUSAL); return ftsConfig(tok); };
const rows = (n: number, from = 0) =>
  Array.from({ length: n }, (_, i) => ({ uid: `r${from + i}`, text: `row ${from + i} backed up to odin NAS` }));

let n = 0;
async function table(count: number) {
  return (await lancedb.connect(join(tmp, `t${n++}`))).createTable("events", rows(count));
}
const textIndex = async (t: lancedb.Table) =>
  (await t.listIndices()).find(i => i.columns.includes("text")) as FtsIndexInfo;

// #104's probe: through the production path, so only the "unknown base tokenizer" refusal reads as no ICU.
const HAS_ICU = (await ensureFtsIndex(await table(1))).tokenizer === "icu";
const REQUIRE_ICU = process.env.RELIC_REQUIRE_ICU === "1";
const icuTest = test.skipIf(!HAS_ICU && !REQUIRE_ICU);
if (!HAS_ICU) console.warn("⚠ this LanceDB build has no ICU (#104) — the ICU coverage tests are skipped");

// Big enough to be behind() whatever the shard size below: the fraction AND the floor.
const base = 2_000;
const enough = Math.max(COVER_MIN_ROWS, Math.ceil(base * COVER_FRACTION / (1 - COVER_FRACTION)) + 1);

describe("behind() — when a gap is worth a rebuild", () => {
  test("no gap, or an index that does not say, is never behind", () => {
    expect([undefined, { name: "i", columns: ["text"] }, { name: "i", columns: ["text"], numUnindexedRows: 0, numIndexedRows: 9 }]
      .map(i => behind(i as FtsIndexInfo))).toEqual([false, false, false]);
    expect(gapOf(undefined)).toBe(0);
  });

  test("behind once the gap reaches the floor AND the fraction of the shard", () => {
    const info = (gap: number, indexed: number): FtsIndexInfo => ({ name: "i", columns: ["text"], numUnindexedRows: gap, numIndexedRows: indexed });
    expect(behind(info(COVER_MIN_ROWS, 0))).toBe(true);                      // a whole new shard's worth
    expect(behind(info(COVER_MIN_ROWS - 1, 0))).toBe(false);                 // under the floor, however big a share
    const big = Math.ceil(COVER_MIN_ROWS / COVER_FRACTION) * 10;             // a shard where the floor is not the limit
    expect(behind(info(Math.floor(big * COVER_FRACTION) - 1, big))).toBe(false);
    expect(behind(info(Math.ceil(big * COVER_FRACTION / (1 - COVER_FRACTION)) + 1, big))).toBe(true);
  });
});

describe("ensureFtsIndex covers rows appended after the index was built (#115)", () => {
  icuTest("a gap past the threshold: rebuilt, covered, and nothing left outside", async () => {
    const t = await table(base);
    await ensureFtsIndex(t);
    await t.add(rows(enough, base));
    expect(gapOf(await textIndex(t))).toBe(enough);
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: true, upgraded: false, covered: enough });
    expect(gapOf(await textIndex(t))).toBe(0);
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: false });
  });

  test("the same for a `simple` index while ICU is still refused", async () => {
    const t = await table(base);
    await ensureFtsIndex(t, {}, noIcu);
    await t.add(rows(enough, base));
    expect(await ensureFtsIndex(t, {}, noIcu)).toMatchObject({ tokenizer: "simple", built: true, covered: enough });
    const i = await textIndex(t);
    expect([i.name, gapOf(i)]).toEqual([SIMPLE_INDEX, 0]);
  });
});

describe("an import run leaves its shards covered", () => {
  // A transcript whose parser returns `count` events — the shape importFiles() consumes.
  const found = (path: string, count: number, mtime: number): Found => ({
    path, projectDir: "p", tier: "session", source: "claude", workflowRunId: null, agentId: null,
    mtime, size: count, bank: "projects115",
    parser: async () => ({
      sessionUuid: "s115", cwd: null, model: "", lines: count, badLines: 0,
      startedAt: "", endedAt: "", description: "", title: "", gitBranch: "",
      events: Array.from({ length: count }, (_, i) => ({ uid: `${path}#${i}`, seq: i + 1, role: "user", ts: "",
                                                      text: `turn ${i} of ${path}: backed up to odin NAS` })),
    }),
  } as unknown as Found);

  test("a transcript that grew past the threshold is covered by the run that re-imported it", async () => {
    const root = join(tmp, "import-root");
    const first = await importFiles([found("/x/live.jsonl", base, 1)], { dataRoot: root, inRepo: false, skipNoise: false });
    expect(first.added).toBe(base);

    // The live session wrote more: the importer drops its rows and writes them all again.
    const second = await importFiles([found("/x/live.jsonl", base + enough, 2)], { dataRoot: root, inRepo: false, skipNoise: false });
    expect(second.imported).toBe(1);
    expect(second.ftsCovered).toBe(1);
    expect(second.ftsCoveredRows).toBe(base + enough);

    const t = await (await lancedb.connect(shardDirFor(null, root, false, "projects115"))).openTable("events");
    expect(await t.countRows()).toBe(base + enough);
    expect(gapOf(await textIndex(t))).toBe(0);
  });

  test("status reports rows outside the index per shard, and the note names them", async () => {
    const root = join(tmp, "status-root");
    await importFiles([found("/x/a.jsonl", 50, 1)], { dataRoot: root, inRepo: false, skipNoise: false });
    // Appended without an import run — the state every shard was in before #115. Copies of real
    // rows, so the test does not have to restate the events schema.
    const t = await (await lancedb.connect(shardDirFor(null, root, false, "projects115"))).openTable("events");
    const copies = (await t.query().limit(7).toArray()).map((r: any) => ({ ...r.toJSON?.() ?? r }));
    await t.add(copies.map((r, i) => ({ ...r, uid: `extra-${i}`, file_path: "/x/b.jsonl" })));

    const { rows: st } = await indexStatus({ dataRoot: root, freshness: false });
    expect(st.map(r => r.unindexed)).toEqual([7]);
    const note = coverageNote(st)!;
    expect(note[0]).toContain("7 rows in 1 shard are not in the full-text index yet");
    expect(note[1]).toContain("projects115");
    expect(coverageNote(st.map(r => ({ ...r, unindexed: 0 })))).toBeNull();
  });
});
