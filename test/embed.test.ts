import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceStore } from "../src/store/lance.js";
import { l2normalise, providerFor, embedShard, type EmbedProvider } from "../src/embed.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-embed-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A provider with no network: deterministic, so assertions are about OUR code. */
const fake = (dim: number, tag = "fake"): EmbedProvider => ({
  id: `test:${tag}`,
  embed: async texts => texts.map(t =>
    Array.from({ length: dim }, (_, i) => ((t.charCodeAt(i % t.length) || 1) % 17) + 1)),
});

describe("widen refuses a vector column", () => {
  /*
   * THE TEST THAT JUSTIFIES THE WHOLE SIDE-TABLE DESIGN.
   *
   * Before this guard, adding `embedding` to EventRow made widen() call
   * addColumns({valueSql: "''"}), which creates a Utf8 column — and a later write of
   * [0.1, 0.2] then SUCCEEDS, storing the string "0.1,0.2". No error at either step.
   * Every vector computed afterwards would land as text.
   */
  test("addColumns with a scalar default would silently make it Utf8", async () => {
    const db = await lancedb.connect(join(tmp, "raw"));
    const t = await db.createTable("c", [{ uid: "x", text: "hi" }]);
    await t.addColumns([{ name: "embedding", valueSql: "''" }]);
    expect(String((await t.schema()).fields.find(f => f.name === "embedding")!.type)).toBe("Utf8");
    await t.mergeInsert("uid").whenMatchedUpdateAll().whenNotMatchedInsertAll()
      .execute([{ uid: "y", text: "yo", embedding: [0.1, 0.2] }]);
    const [row] = await t.query().where("uid = 'y'").toArray();
    // This is the bug, reproduced: a vector, stored as a comma-joined string.
    expect(typeof row.embedding).toBe("string");
    expect(row.embedding).toBe("0.1,0.2");
  });

  test("the guard stops it before that can happen", async () => {
    const store = await LanceStore.open(join(tmp, "guard"));
    await store.putFiles([{ file_path: "/a", repo_key: "r", mtime: 1, size: 2, imported_at: "" }]);
    // A second write carrying an extra ARRAY field is the shape that used to poison.
    await expect(store.putFiles([
      { file_path: "/b", repo_key: "r", mtime: 1, size: 2, imported_at: "", embedding: [1, 2] } as any,
    ])).rejects.toThrow(/non-scalar column "embedding"/);
  });
});

describe("l2normalise", () => {
  test("unit length, and cosine order is preserved", () => {
    const v = l2normalise([3, 4]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect(v[0]).toBeCloseTo(0.6, 12);
  });
  test("a zero vector is left alone, not turned into NaN", () => {
    // Division by zero here would poison every later comparison silently — a NaN
    // distance sorts unpredictably rather than erroring.
    expect(l2normalise([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe("providers", () => {
  test("ollama id is provider-qualified", () => {
    expect(providerFor("ollama", "all-minilm").id).toBe("ollama:all-minilm");
  });
  test("an unknown provider names the two that exist", () => {
    // "st" used to throw here and point at relic-py. It no longer does: TypeScript
    // reaches the same models through the Python sidecar, so the two front ends offer
    // the same providers. See the st-provider describe block below.
    expect(() => providerFor("nope", "x")).toThrow(/expected "ollama" or "st"/);
  });
});

describe("embedShard", () => {
  const mkStore = async (name: string, n: number) => {
    const s = await LanceStore.open(join(tmp, name));
    await s.putEvents(Array.from({ length: n }, (_, i) => ({
      uid: `u${i}`, session_uuid: "s", file_path: "/f", repo_key: "r", seq: i,
      role: "user", ts: "", text: `event number ${i} with enough text to pass min-chars`,
      source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
      org: "", project: "", dir: "", mem_type: "", origin_session: "",
    })));
    return s;
  };

  test("writes a typed vector column, not a string one", async () => {
    const s = await mkStore("ok", 5);
    const r = await embedShard(s, fake(8), { mainTiers: true });
    expect(r.embedded).toBe(5);
    expect(r.dim).toBe(8);
    const st = await s.vectorStats();
    expect(st).toEqual({ rows: 5, model: "test:fake", dim: 8, norm: "l2" });
    // The whole point: events is untouched.
    const db = await lancedb.connect(join(tmp, "ok"));
    const ev = await db.openTable("events");
    expect((await ev.schema()).fields.some(f => f.name === "embedding")).toBe(false);
    const vec = await db.openTable("vectors");
    expect(String((await vec.schema()).fields.find(f => f.name === "embedding")!.type))
      .toContain("FixedSizeList[8]");
  });

  test("is resumable — a second run does nothing", async () => {
    const s = await mkStore("resume", 4);
    expect((await embedShard(s, fake(8), {})).embedded).toBe(4);
    const again = await embedShard(s, fake(8), {});
    expect(again.embedded).toBe(0);
    expect(again.pending).toBe(0);
    expect(again.already).toBe(4);
  });

  test("--limit caps the run and leaves the rest pending", async () => {
    const s = await mkStore("limit", 10);
    expect((await embedShard(s, fake(8), { limit: 3 })).embedded).toBe(3);
    expect((await embedShard(s, fake(8), { limit: 3 })).already).toBe(3);
  });

  test("dry run counts without writing", async () => {
    const s = await mkStore("dry", 6);
    const r = await embedShard(s, fake(8), { dryRun: true });
    expect(r.pending).toBe(6);
    expect(r.embedded).toBe(0);
    expect(await s.vectorStats()).toBeNull();
  });

  test("refuses a second model rather than failing mid-batch", async () => {
    // A FixedSizeList has one width, so mixing dims would fail partway through a long
    // backfill, after work has already landed. Skipping with a reason is the contract.
    const s = await mkStore("mismatch", 4);
    await embedShard(s, fake(8, "a"), {});
    const r = await embedShard(s, fake(16, "b"), {});
    expect(r.embedded).toBe(0);
    expect(r.skipped).toMatch(/--reset/);
    expect((await s.vectorStats())!.dim).toBe(8);
  });

  test("--reset drops vectors and only vectors", async () => {
    const s = await mkStore("reset", 4);
    await embedShard(s, fake(8, "a"), {});
    const r = await embedShard(s, fake(16, "b"), { reset: true });
    expect(r.embedded).toBe(4);
    expect((await s.vectorStats())!.dim).toBe(16);
    // events survived — the reset can never cost an index run
    expect((await s.counts()).events).toBe(4);
  });

  test("minChars drops events too short to mean anything", async () => {
    const s = await LanceStore.open(join(tmp, "short"));
    await s.putEvents([
      { uid: "a", session_uuid: "s", file_path: "/f", repo_key: "r", seq: 0, role: "user",
        ts: "", text: "ok", source: "claude", tier: "session", kind: "transcript",
        worktree: "", cwd: "", org: "", project: "", dir: "", mem_type: "", origin_session: "" },
      { uid: "b", session_uuid: "s", file_path: "/f", repo_key: "r", seq: 1, role: "user",
        ts: "", text: "a sentence long enough to carry meaning", source: "claude",
        tier: "session", kind: "transcript", worktree: "", cwd: "", org: "", project: "",
        dir: "", mem_type: "", origin_session: "" },
    ]);
    expect((await embedShard(s, fake(8), {})).embedded).toBe(1);
  });

  test("one bad batch costs its own rows, not the run", async () => {
    const s = await mkStore("partial", 4);
    let call = 0;
    const flaky: EmbedProvider = {
      id: "test:flaky",
      embed: async texts => { if (call++ === 0) throw new Error("boom");
                              return texts.map(() => Array(8).fill(1)); },
    };
    const r = await embedShard(s, flaky, { batch: 2 });
    expect(r.failed).toBe(2);
    expect(r.embedded).toBe(2);
    // and the failed uids are simply pending again
    expect((await embedShard(s, fake(8, "flaky"), { batch: 2 })).pending).toBe(2);
  });
});

describe("the st provider — TypeScript reaches the Python models", () => {
  /*
   * NO SPAWN HERE. The sidecar needs uv plus a torch-sized download, so a live test
   * would be slow and environment-dependent. What these assert is the part that breaks
   * silently: the provider ID.
   *
   * `embedShard` refuses a shard whose stored model differs from the running provider's
   * id. If TypeScript and Python computed that string differently, each would refuse the
   * other's shards — while both looked correct in isolation. The literal below is the
   * contract, and python/relicpy/embed.py asserts the same one.
   */
  test("the e5 prefix is inferred and recorded in the id", () => {
    expect(providerFor("st", "intfloat/multilingual-e5-small").id)
      .toBe("st:intfloat/multilingual-e5-small+passage:");
  });
  test("a non-e5 model carries no prefix", () => {
    expect(providerFor("st", "sentence-transformers/all-MiniLM-L6-v2").id)
      .toBe("st:sentence-transformers/all-MiniLM-L6-v2");
  });
  test("both providers are named, and nothing else is", () => {
    expect(providerFor("ollama", "all-minilm").id).toBe("ollama:all-minilm");
    expect(() => providerFor("nope", "x")).toThrow(/expected "ollama" or "st"/);
  });
  test("a long-lived provider exposes close(), a stateless one does not", () => {
    // embedShards calls close?.() unconditionally; an orphaned python holding a model
    // is ~500 MB of RSS that never comes back.
    expect(typeof providerFor("st", "x").close).toBe("function");
    expect(providerFor("ollama", "x").close).toBeUndefined();
  });
});
