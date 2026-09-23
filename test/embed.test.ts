import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceStore } from "../src/store/lance.js";
import { l2normalise, providerFor, queryProviderFor, embedShard, embedShards, type EmbedProvider } from "../src/embed.js";
import { checkEmbedModel, renderEmbedCheck, CHECK_MIN_EVENTS, type EmbedCheck } from "../src/langs.js";
import { shardDirFor } from "../src/repo.js";
import { uidOf } from "../src/types.js";

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

describe("queryProviderFor — reading a writer's id back", () => {
  /*
   * The stored id is the ONLY trustworthy record of how a shard's vectors were made.
   * Re-deriving the model from a flag would let a query be embedded by a different
   * model than the documents, which produces confident nonsense rather than an error:
   * both sides are floats of the same width and the distance computes fine.
   */
  test("an e5 writer's passage prefix becomes the query prefix", () => {
    // Asymmetric families want "passage: " on documents and "query: " on queries.
    // Using the document prefix to embed a query costs recall SILENTLY.
    expect(queryProviderFor("st:intfloat/multilingual-e5-small+passage:").id)
      .toBe("st:intfloat/multilingual-e5-small+query:");
  });
  test("a symmetric st model gets no prefix either way", () => {
    expect(queryProviderFor("st:sentence-transformers/all-MiniLM-L6-v2").id)
      .toBe("st:sentence-transformers/all-MiniLM-L6-v2");
  });
  test("ollama round-trips unchanged", () => {
    expect(queryProviderFor("ollama:bge-m3").id).toBe("ollama:bge-m3");
  });
  test("a model name containing ':' survives — ollama tags use one", () => {
    expect(queryProviderFor("ollama:qwen3-embedding:0.6b").id).toBe("ollama:qwen3-embedding:0.6b");
  });
  test("an unreadable id is refused, not guessed", () => {
    expect(() => queryProviderFor("garbage")).toThrow(/unreadable stored model id/);
    expect(() => queryProviderFor("weird:thing")).toThrow(/unknown stored provider/);
  });
});

describe("vectorSearch", () => {
  const mk = async (name: string) => {
    const s = await LanceStore.open(join(tmp, name));
    await s.putEvents(["alpha", "beta", "gamma"].map((w, i) => ({
      uid: `v${i}`, session_uuid: "s", file_path: "/f", repo_key: "r", seq: i,
      role: i === 2 ? "tool_use" : "user", ts: `2026-09-0${i + 1}T00:00:00Z`,
      text: `${w} a sentence long enough to pass the minimum length`,
      source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
      org: "", project: "", dir: "", mem_type: "", origin_session: "",
    })));
    // Unit vectors so cosine is exactly 1 - d^2/2 and the expected scores are known.
    await s.putVectors([
      { uid: "v0", embedding: [1, 0], model: "test:x", dim: 2, norm: "l2", embedded_at: "" },
      { uid: "v1", embedding: [0, 1], model: "test:x", dim: 2, norm: "l2", embedded_at: "" },
      { uid: "v2", embedding: [1, 0], model: "test:x", dim: 2, norm: "l2", embedded_at: "" },
    ]);
    return s;
  };

  test("ranks by cosine, and an exact match scores 1", async () => {
    const s = await mk("vs");
    const hits = await s.vectorSearch([1, 0], { limit: 3 });
    expect(hits.length).toBe(3);
    expect(Number((hits[0] as any)._score)).toBeCloseTo(1, 6);
    // orthogonal vector -> cosine 0, and it sorts last
    expect(Number((hits[2] as any)._score)).toBeCloseTo(0, 6);
    expect(hits[2].uid).toBe("v1");
  });

  test("the scalar filter is applied to the EVENTS, after the vector hop", async () => {
    // The vectors table has no tier/role columns to pre-filter on, by design — so this
    // is a post-filter, and the overfetch exists to stop it starving the page.
    const s = await mk("vsf");
    const hits = await s.vectorSearch([1, 0], { limit: 3, role: "tool_use" });
    expect(hits.map(h => h.uid)).toEqual(["v2"]);
  });

  test("a store with no vectors returns nothing rather than throwing", async () => {
    // `index` never writes vectors, so this is the NORMAL state of most shards and
    // must not abort a fan-out across hundreds of them.
    const s = await LanceStore.open(join(tmp, "vs-none"));
    await s.putFiles([{ file_path: "/a", repo_key: "r", mtime: 1, size: 2, imported_at: "" }]);
    expect(await s.vectorSearch([1, 0], { limit: 5 })).toEqual([]);
  });
});

describe("the language check — embed measures its scope before any provider call (#101)", () => {
  const THAI = "สวัสดีครับ วันนี้อากาศดีมาก ขอบคุณมาก";
  const PROSE = "Fix the bug in the parser and add a test for it please";
  type Ev = { text: string; session?: string; tier?: string };
  const times = (n: number, e: Ev): Ev[] => Array.from({ length: n }, () => e);
  // 10 Thai events in 30: a third of the scope, far over the 1% line.
  const THAI_MIX = [...times(10, { text: THAI }), ...times(20, { text: PROSE })];

  /** One shard per repo under a data root; calling it again with the same name adds shards. */
  const mkRoot = async (name: string, repos: Record<string, Ev[]>, bank?: string) => {
    const root = join(tmp, name);
    for (const [repo, events] of Object.entries(repos)) {
      const store = await LanceStore.open(shardDirFor(`github.com/o/${repo}`, root, false, bank));
      await store.putEvents(events.map((e, seq) => ({
        uid: uidOf("claude", `${repo}.jsonl`, seq), session_uuid: e.session ?? "s", file_path: `/${repo}.jsonl`,
        repo_key: `github.com/o/${repo}`, seq, role: "user", ts: "", text: e.text, source: "claude",
        tier: e.tier ?? "session", kind: "transcript", worktree: "", cwd: "", org: "o", project: "",
        dir: "", mem_type: "", origin_session: "",
      })));
    }
    return root;
  };

  /** Under a real model's id, and counting calls: a refusal must come before the first one. */
  const provider = (id: string) => {
    let calls = 0;
    return { id, calls: () => calls, embed: async (texts: string[]) => { calls++; return fake(8).embed(texts); } };
  };
  const vectorsIn = async (root: string, repo: string) =>
    (await LanceStore.open(shardDirFor(`github.com/o/${repo}`, root))).vectorStats();

  test("an English-only model on a Thai scope is refused: nothing embedded, no provider call", async () => {
    const root = await mkRoot("check-refuse", { mix: THAI_MIX });
    const p = provider("ollama:all-minilm");
    let seen: EmbedCheck | undefined;
    const r = await embedShards({ dataRoot: root, onCheck: c => { seen = c; } }, p);
    expect(r.refused).toBe(true);
    expect(seen).toBe(r.check);
    expect(r.check).toMatchObject({ action: "refuse", fit: "english-only", verdict: "multilingual" });
    expect(r.check.thaiShare).toBeCloseTo(1 / 3);
    expect(r.shards).toEqual([]);
    expect(p.calls()).toBe(0);
    expect(await vectorsIn(root, "mix")).toBeNull();

    // The multilingual candidates come from recommend(): Ollama first, as embed's default provider.
    expect(r.check.candidates.map(c => c.model)).toEqual(["bge-m3", "qwen3-embedding:0.6b",
      "intfloat/multilingual-e5-small", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"]);
    const text = renderEmbedCheck(r.check);
    expect(text).toContain("embed REFUSED — ollama:all-minilm is English-only, and this scope is not");
    expect(text).toContain("33.3% of eligible events carry Thai, at or above 1.0%");
    expect(text).toContain("-> relic embed --model bge-m3");
    expect(text).toContain("--force embeds with ollama:all-minilm anyway. The whole mix, by role, and the vectors on disk: relic langs");
  });

  test("--force proceeds, and still says what it is forcing", async () => {
    const root = await mkRoot("check-force", { mix: THAI_MIX });
    const p = provider("ollama:all-minilm");
    const r = await embedShards({ dataRoot: root, force: true }, p);
    expect(r.refused).toBe(false);
    expect(r.check.action).toBe("forced");
    expect(r.embedded).toBe(30);
    expect(p.calls()).toBeGreaterThan(0);
    expect((await vectorsIn(root, "mix"))?.model).toBe("ollama:all-minilm");
    expect(renderEmbedCheck(r.check)).toContain("--force: embedding with ollama:all-minilm, which is English-only");
  });

  test("a multilingual model passes silently, under every form of its id", async () => {
    const root = await mkRoot("check-multi", { mix: THAI_MIX });
    // st records its e5 prefix in the id, and Ollama may carry its default tag.
    for (const id of ["ollama:bge-m3", "ollama:bge-m3:latest", "st:intfloat/multilingual-e5-small+passage:"]) {
      const c = (await embedShards({ dataRoot: root, dryRun: true }, provider(id))).check;
      expect(c).toMatchObject({ action: "pass", fit: "fits" });
      expect(renderEmbedCheck(c)).toBe("");
    }
    expect((await embedShards({ dataRoot: root }, provider("ollama:bge-m3"))).embedded).toBe(30);
  });

  test("an unmeasured model gets a note, not a refusal", async () => {
    const root = await mkRoot("check-unmeasured", { mix: THAI_MIX });
    const r = await embedShards({ dataRoot: root }, provider("ollama:nomic-embed-text-v2-moe"));
    expect(r.refused).toBe(false);
    expect(r.check).toMatchObject({ action: "note", fit: "unmeasured" });
    expect(r.embedded).toBe(30);
    const text = renderEmbedCheck(r.check);
    expect(text).toContain("ollama:nomic-embed-text-v2-moe is not measured here");
    expect(text).not.toContain("REFUSED");
  });

  test("an English-only model on an English scope passes silently", async () => {
    const root = await mkRoot("check-english", { en: times(20, { text: PROSE }) });
    const r = await embedShards({ dataRoot: root }, provider("ollama:all-minilm"));
    expect(r.check).toMatchObject({ action: "pass", verdict: "english", thaiShare: 0 });
    expect(renderEmbedCheck(r.check)).toBe("");
    expect(r.embedded).toBe(20);
  });

  test("--dry-run shows the same check, and still counts without writing", async () => {
    const root = await mkRoot("check-dry", { mix: THAI_MIX });
    const p = provider("ollama:all-minilm");
    const r = await embedShards({ dataRoot: root, dryRun: true }, p);
    expect(r.refused).toBe(false);
    expect(r.check.action).toBe("refuse");
    expect(r.pending).toBe(30);
    expect(p.calls()).toBe(0);
    expect(await vectorsIn(root, "mix")).toBeNull();
    expect(renderEmbedCheck(r.check, true)).toContain("Without --force, a real run stops here");
  });

  test("a thin sample is read in full; a thick one stays a sample", async () => {
    // 1 in 64 of 30 events is zero or one event, which cannot see 1% of anything.
    const thin = (await embedShards({ dataRoot: await mkRoot("check-thin", { mix: THAI_MIX }), dryRun: true },
                                     provider("ollama:all-minilm"))).check;
    expect(thin).toMatchObject({ rate: 1, events: 30, action: "refuse" });
    const thick = await checkEmbedModel("ollama:all-minilm",
      { dataRoot: await mkRoot("check-thick", { big: times(2_500, { text: PROSE }) }), sample: 2 });
    expect(thick.rate).toBe(0.5);
    expect(thick.events).toBeGreaterThanOrEqual(CHECK_MIN_EVENTS);
  });

  test("--repo and --bank narrow the check to the shards embed would read", async () => {
    const root = await mkRoot("check-bank", { en: times(20, { text: PROSE }) });
    await mkRoot("check-bank", { notes: THAI_MIX }, "vault");
    const check = async (o: { repo?: string; bank?: string }) =>
      (await embedShards({ dataRoot: root, dryRun: true, ...o }, provider("ollama:all-minilm"))).check.action;
    expect(await check({})).toBe("refuse");
    expect(await check({ bank: "default" })).toBe("pass");
    expect(await check({ bank: "vault" })).toBe("refuse");
    expect(await check({ repo: "en" })).toBe("pass");
    expect(await check({ repo: "notes" })).toBe("refuse");
  });

  test("--all-tiers, --min-chars and --max-chars move the population the check measures", async () => {
    const LONG = PROSE.repeat(40) + " " + THAI;      // 2,200 chars of English, then Thai
    const root = await mkRoot("check-flags", { en: [
      ...times(20, { text: PROSE }),
      ...times(10, { text: THAI, tier: "subagent" }), // not a main tier
      ...times(10, { text: "สวัสดีครับ" }),            // under --min-chars 24
      ...times(10, { text: LONG }),                   // its Thai is past --max-chars 2000
    ] });
    const check = async (o: { mainTiers?: boolean; minChars?: number; maxChars?: number }) =>
      (await embedShards({ dataRoot: root, dryRun: true, ...o }, provider("ollama:all-minilm"))).check;
    expect(await check({})).toMatchObject({ action: "pass", events: 30 });
    expect(await check({ mainTiers: false })).toMatchObject({ action: "refuse", events: 40 });
    expect(await check({ minChars: 4 })).toMatchObject({ action: "refuse", events: 40 });
    expect(await check({ maxChars: 3000 })).toMatchObject({ action: "refuse", events: 30 });
  });

  test("--session reads every event of that one session, and nothing else", async () => {
    const root = await mkRoot("check-session", { two: [
      ...times(5, { text: THAI, session: "th" }), ...times(40, { text: PROSE, session: "en" })] });
    const run = (session: string) => embedShards({ dataRoot: root, session, dryRun: true,
      scopeArgs: ["--session", session] }, provider("ollama:all-minilm"));
    const th = (await run("th")).check;
    expect(th).toMatchObject({ action: "refuse", rate: 1, events: 5, thaiShare: 1 });
    expect(th.command).toBe("relic embed --model bge-m3 --session th");
    expect(th.langsCommand).toBe("relic langs");     // langs takes no --session
    expect((await run("en")).check).toMatchObject({ action: "pass", events: 40 });
  });

  test("the printed commands carry the scope that was measured", async () => {
    const root = await mkRoot("check-scope-args", { mix: THAI_MIX });
    const c = (await embedShards({ dataRoot: root, repo: "mix", dryRun: true,
      scopeArgs: ["--data-root", root, "--repo", "mix"] }, provider("ollama:all-minilm"))).check;
    expect(c.command).toBe(`relic embed --model bge-m3 --data-root ${root} --repo mix`);
    expect(c.langsCommand).toBe(`relic langs --data-root ${root} --repo mix`);
  });

  test("vectors already on disk that fit are the next step, not a candidate that starts over", async () => {
    const root = await mkRoot("check-kept", { mix: THAI_MIX });
    await embedShards({ dataRoot: root }, provider("st:intfloat/multilingual-e5-small+passage:"));
    const c = (await embedShards({ dataRoot: root, dryRun: true }, provider("ollama:all-minilm"))).check;
    expect(c.kept).toBe("st:intfloat/multilingual-e5-small+passage:");
    expect(c.command).toBe("relic embed --provider st --model intfloat/multilingual-e5-small");
    expect(renderEmbedCheck(c, true)).toContain("(st:intfloat/multilingual-e5-small+passage: is already on disk here, and fits)");
  });

  describe("the CLI", () => {
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const relic = (root: string, ...args: string[]) => {
      // HOME is a temp dir, so nothing can reach the live index even if --data-root were dropped.
      const out = Bun.spawnSync(["bun", cli, "embed", "--data-root", root, ...args],
                                { env: { ...process.env, HOME: tmp }, stdout: "pipe", stderr: "pipe" });
      return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
    };

    test("a refusal exits 1 with the reason on stderr, and --json stays one document", async () => {
      const root = await mkRoot("check-cli", { mix: THAI_MIX });
      const plain = relic(root);
      expect(plain.code).toBe(1);
      expect(plain.stderr).toContain("embed REFUSED — ollama:all-minilm is English-only");
      expect(plain.stdout).toBe("");
      const json = relic(root, "--json");
      expect(json.code).toBe(1);
      expect(JSON.parse(json.stdout)).toMatchObject({ refused: true, shards: [], check: { action: "refuse" } });
    });

    test("--dry-run prints the check, the counts, and the refusal again under them", async () => {
      const root = await mkRoot("check-cli-dry", { mix: THAI_MIX });
      const dry = relic(root, "--dry-run");
      expect(dry.code).toBe(0);
      expect(dry.stderr).toContain("Without --force, a real run stops here");
      expect(dry.stdout).toContain("30 pending");
      expect(dry.stdout).toContain("the language check refuses ollama:all-minilm for this scope");
      // A model that fits prints nothing about languages at all.
      const multi = relic(root, "--dry-run", "--model", "bge-m3");
      expect(multi.code).toBe(0);
      expect(multi.stderr).toBe("");
    });
  });
});
