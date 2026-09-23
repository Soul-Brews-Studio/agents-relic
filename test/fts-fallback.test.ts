import { expect, test, describe, afterAll } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFtsIndex, tokenizerOf, ftsConfig, SIMPLE_INDEX, type Tokenizer } from "../src/store/fts.js";
import { LanceStore } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import { indexStatus, searchEvents, degradedNote } from "../src/query.js";

// Issue #63: some LanceDB builds refuse ICU. Every machine here HAS ICU, so the refusal is injected.
const tmp = mkdtempSync(join(tmpdir(), "relic-fts-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu, tokenizer.rs:340:17";
const noIcu = (tok: Tokenizer) => { if (tok === "icu") throw new Error(REFUSAL); return ftsConfig(tok); };

let n = 0;
async function table() {
  const db = await lancedb.connect(join(tmp, `t${n++}`));
  return db.createTable("events", [
    { uid: "a", text: "ความสุข structured_output_mode hello" },
    { uid: "b", text: "Air4Thai sensor ความ" },
  ]);
}
const names = async (t: lancedb.Table) => (await t.listIndices()).map(i => i.name).sort();

describe("ensureFtsIndex — ICU first, `simple` only on a build without ICU", () => {
  test("ICU available: one ICU index, no fallback", async () => {
    const t = await table();
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: true, upgraded: false });
    expect(await names(t)).toEqual(["text_idx"]);
    expect(await tokenizerOf(t)).toBe("icu");
  });

  test("ICU refused: builds `simple` under a name that records it, and search still works", async () => {
    const t = await table();
    const r = await ensureFtsIndex(t, {}, noIcu);
    expect(r.tokenizer).toBe("simple");
    expect(r.built).toBe(true);
    expect(r.fellBack).toContain("unknown base tokenizer icu");
    expect(await names(t)).toEqual([SIMPLE_INDEX]);
    expect(await tokenizerOf(t)).toBe("simple");
    expect((await t.search("Air4Thai", "fts").limit(5).toArray()).length).toBe(1);
  });

  test("still refused on the next run: the fallback is kept, not rebuilt", async () => {
    const t = await table();
    await ensureFtsIndex(t, {}, noIcu);
    const r = await ensureFtsIndex(t, {}, noIcu);
    expect(r).toMatchObject({ tokenizer: "simple", built: false });
    expect(await names(t)).toEqual([SIMPLE_INDEX]);
  });

  test("a later run WITH ICU upgrades the shard and drops the fallback", async () => {
    const t = await table();
    await ensureFtsIndex(t, {}, noIcu);
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: true, upgraded: true });
    expect(await names(t)).toEqual(["text_idx"]);
    // ICU segments Thai, so a word inside a sentence becomes findable.
    expect((await t.search("ความ", "fts").limit(5).toArray()).length).toBe(2);
  });

  test("an upgrade interrupted between create and drop is finished on the next run", async () => {
    const t = await table();
    await ensureFtsIndex(t, {}, noIcu);
    await t.createIndex("text", { config: ftsConfig("icu") });
    expect(await names(t)).toEqual(["text_fts_simple", "text_idx"]);
    expect(await ensureFtsIndex(t)).toEqual({ tokenizer: "icu", built: false });
    expect(await names(t)).toEqual(["text_idx"]);
  });

  test("any OTHER failure still throws — only a missing tokenizer earns the fallback", async () => {
    const t = await table();
    const broken = () => { throw new Error("disk full"); };
    await expect(ensureFtsIndex(t, {}, broken)).rejects.toThrow("disk full");
    expect(await names(t)).toEqual([]);
  });

  test("an existing ICU index is left alone", async () => {
    const t = await table();
    await ensureFtsIndex(t);
    expect(await ensureFtsIndex(t, {}, noIcu)).toEqual({ tokenizer: "icu", built: false });
  });
});

describe("the record is read where people look — status and the search header", () => {
  const root = join(tmp, "root");
  const ev = (uid: string, text: string) => ({
    uid, session_uuid: "s1", file_path: `/x/${uid}.jsonl`, repo_key: "github.com/o/thai", seq: 1, role: "user",
    ts: "2026-09-23T00:00:00.000Z", text, source: "claude", tier: "session", kind: "transcript", worktree: "",
    cwd: "/x", org: "o", project: "", dir: "", mem_type: "", origin_session: "",
  });

  test("a `simple` shard is named by indexStatus and by searchEvents", async () => {
    const st = await LanceStore.open(shardDirFor("github.com/o/thai", root));
    await st.putEvents([ev("a", "Air4Thai sensor ความ"), ev("b", "hello world")]);
    expect(await st.ensureFtsIndex({}, noIcu)).toMatchObject({ tokenizer: "simple" });

    const { rows } = await indexStatus({ dataRoot: root, freshness: false });
    expect(rows.map(r => r.fts)).toEqual(["simple"]);

    const res = await searchEvents("Air4Thai", { dataRoot: root, warnGeneric: false });
    expect(res.hits.length).toBe(1);
    expect(res.degraded).toEqual([rows[0].key]);
    expect(degradedNote(res.degraded, res.shards)).toContain("Thai word-internal matches are missed");

    // Rebuilt with ICU: the warning goes away on its own.
    expect(await st.ensureFtsIndex()).toMatchObject({ tokenizer: "icu", upgraded: true });
    expect((await searchEvents("Air4Thai", { dataRoot: root, warnGeneric: false })).degraded).toEqual([]);
    expect((await indexStatus({ dataRoot: root, freshness: false })).rows[0].fts).toBe("icu");
  });

  test("no degraded shards means no note at all", () => {
    expect(degradedNote([], 10)).toBeNull();
    expect(degradedNote(undefined, 10)).toBeNull();
  });
});
