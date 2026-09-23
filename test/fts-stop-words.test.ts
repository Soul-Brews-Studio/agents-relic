import { expect, test, describe, afterAll } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import { Index } from "@lancedb/lancedb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFtsIndex, ftsConfig, drifted, SIMPLE_INDEX, type FtsTable, type Tokenizer } from "../src/store/fts.js";
import { LanceStore } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import { rebuildFts } from "../src/fts-rebuild.js";

/*
 * Issue #97: `relic search nas` answered 0 on an index holding hundreds of lines with NAS
 * in them. LanceDB's default removeStopWords, under ICU, filters 21 languages' stop words
 * at once, so `nas` (Portuguese), `bin` (German) and `min` (Swedish) never reached the
 * index. The query tokenized to nothing and FTS answered [] without an error.
 */
const tmp = mkdtempSync(join(tmpdir(), "relic-stopwords-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu, tokenizer.rs:340:17";
const noIcu = (tok: Tokenizer) => { if (tok === "icu") throw new Error(REFUSAL); return ftsConfig(tok); };
// Every shard built before #97: LanceDB's stop-word default, which indexDetails records as true.
const before = (tok: Tokenizer) => Index.fts({ baseTokenizer: tok, stem: false, maxTokenLength: 128, removeStopWords: true });

let n = 0;
async function table() {
  const db = await lancedb.connect(join(tmp, `t${n++}`));
  return db.createTable("events", [
    { uid: "a", text: "All 15 files backed up to odin NAS." },
    { uid: "b", text: "bin min var dir — is it not" },
  ]);
}
const hits = async (t: lancedb.Table, q: string) => (await t.search(q, "fts").limit(10).toArray()).length;
const names = async (t: lancedb.Table) => (await t.listIndices()).map(i => i.name).sort();

// #104's probe: through the production path, so only the "unknown base tokenizer" refusal reads as no ICU.
const HAS_ICU = (await ensureFtsIndex(await table())).tokenizer === "icu";
const REQUIRE_ICU = process.env.RELIC_REQUIRE_ICU === "1";
const icuTest = test.skipIf(!HAS_ICU && !REQUIRE_ICU);
if (!HAS_ICU) console.warn("⚠ this LanceDB build has no ICU (#104) — the ICU stop-word tests are skipped");

describe("ftsConfig keeps every word (#97)", () => {
  icuTest("ICU: `nas` in \"odin NAS\" is findable, and so are `bin` and `min`", async () => {
    const t = await table();
    expect(await ensureFtsIndex(t)).toMatchObject({ tokenizer: "icu", built: true });
    for (const q of ["nas", "NAS", "bin", "min", "var", "is", "not"]) expect([q, await hits(t, q)]).toEqual([q, 1]);
    expect((await t.tokenize("odin NAS backup", { column: "text" } as any)).map((x: any) => x.text))
      .toEqual(["odin", "nas", "backup"]);
  });

  test("`simple` keeps them too — its English list dropped `is` and `not`", async () => {
    const t = await table();
    expect(await ensureFtsIndex(t, {}, noIcu)).toMatchObject({ tokenizer: "simple", built: true });
    for (const q of ["nas", "bin", "is", "not"]) expect([q, await hits(t, q)]).toEqual([q, 1]);
  });
});

describe("an index built before #97 is stale, and rebuilt", () => {
  icuTest("the next ensureFtsIndex rebuilds a stale ICU index, then leaves it alone", async () => {
    const t = await table();
    await t.createIndex("text", { config: before("icu") });
    expect(await hits(t, "nas")).toBe(0);   // what every shard answered before this fix
    expect(drifted((await t.listIndices())[0].indexDetails)).toBe(true);

    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: true, upgraded: false, drifted: true });
    expect(await hits(t, "nas")).toBe(1);
    expect(await names(t)).toEqual(["text_idx"]);
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: false });
  });

  test("a stale `simple` index is rebuilt as `simple` while ICU is still refused", async () => {
    const t = await table();
    await t.createIndex("text", { config: before("simple"), name: SIMPLE_INDEX });
    expect(await hits(t, "is")).toBe(0);

    expect(await ensureFtsIndex(t, {}, noIcu)).toMatchObject({ tokenizer: "simple", built: true, drifted: true });
    expect(await hits(t, "is")).toBe(1);
    expect(await names(t)).toEqual([SIMPLE_INDEX]);
    expect(await ensureFtsIndex(t, {}, noIcu)).toMatchObject({ tokenizer: "simple", built: false });
  });

  icuTest("never ICU -> `simple`: a stale ICU index on a build without ICU is kept, not doubled", async () => {
    const t = await table();
    await t.createIndex("text", { config: before("icu") });
    for (const rebuild of [false, true]) {
      const r = await ensureFtsIndex(t, { rebuild }, noIcu);
      expect(r).toMatchObject({ tokenizer: "icu", built: false });
      expect(r.fellBack).toContain("unknown base tokenizer");
      expect(await names(t)).toEqual(["text_idx"]);
    }
  });

  test("no indexDetails is UNKNOWN, not drift — rebuilt only when asked", async () => {
    expect([undefined, null, {}, { remove_stop_words: null }, { remove_stop_words: false }].map(drifted))
      .toEqual([false, false, false, false, false]);
    expect(drifted({ remove_stop_words: true })).toBe(true);

    const created: string[] = [];
    const fake: FtsTable = {
      listIndices: async () => [{ name: "text_idx", columns: ["text"] }],
      createIndex: async (col: string) => { created.push(col); },
      dropIndex: async () => {},
    };
    expect(await ensureFtsIndex(fake)).toEqual({ tokenizer: "icu", built: false });
    expect(created).toEqual([]);
    expect(await ensureFtsIndex(fake, { rebuild: true })).toMatchObject({ tokenizer: "icu", built: true });
    expect(created).toEqual(["text"]);
  });
});

describe("rebuildFts — `relic index --fts-rebuild`, every shard on disk", () => {
  const ev = (uid: string, repo: string, text: string) => ({
    uid, session_uuid: "s1", file_path: `/x/${uid}.jsonl`, repo_key: repo, seq: 1, role: "user",
    ts: "2026-09-23T00:00:00.000Z", text, source: "claude", tier: "session", kind: "transcript", worktree: "",
    cwd: "/x", org: "o", project: "", dir: "", mem_type: "", origin_session: "",
  });

  test("rebuilds stale and current shards alike, counts the stale ones, and skips a shard with no events", async () => {
    const root = join(tmp, "root");
    const stale = await LanceStore.open(shardDirFor("github.com/o/stale", root));
    await stale.putEvents([ev("a", "github.com/o/stale", "backed up to odin NAS")]);
    await stale.ensureFtsIndex({}, before);
    const current = await LanceStore.open(shardDirFor("github.com/o/current", root));
    await current.putEvents([ev("b", "github.com/o/current", "bin min var")]);
    await current.ensureFtsIndex();
    await LanceStore.open(shardDirFor("github.com/o/empty", root));   // a shard dir with no tables

    const r = await rebuildFts({ dataRoot: root, inRepo: false });
    expect(r).toMatchObject({ shards: 3, rebuilt: 2, drifted: 1, empty: 1, kept: 0, failed: [] });
    // Without ICU both are rebuilt with `simple`, and named — the same record the importer keeps.
    expect(r.simple.length).toBe(HAS_ICU ? 0 : 2);
    // Reopened: a table handle opened before the rebuild keeps reading the version it opened.
    expect((await (await LanceStore.open(shardDirFor("github.com/o/stale", root))).search("nas")).length).toBe(1);
  });
});
