import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, existsSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LanceStore } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import { l2normalise, providerFor, queryProviderFor, embedShard, damageNote, type EmbedProvider,
         type ShardEmbedStat } from "../src/embed.js";

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

describe("an interrupted embed, and a vectors table that no longer reads (#105)", () => {
  const seed = async (dir: string, n: number) => {
    const s = await LanceStore.open(dir);
    await s.putEvents(Array.from({ length: n }, (_, i) => ({
      uid: `u${i}`, session_uuid: "s", file_path: "/f", repo_key: "r", seq: i,
      role: "user", ts: "", text: `event number ${i} with enough text to pass min-chars`,
      source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
      org: "", project: "", dir: "", mem_type: "", origin_session: "",
    })));
    return s;
  };
  const versionOf = async (dir: string) => (await (await lancedb.connect(dir)).openTable("vectors")).version();

  /*
   * The REPORTED state, built on purpose: the two newest versions reference data files
   * that are 0 bytes, while the first commit's file is intact. That is the shape in the
   * issue (two 0-byte files beside one 200 KB file). A kill alone does not produce it;
   * the SIGKILL test below pins what a kill does leave. So this truncates exactly the
   * files those versions wrote.
   *
   * 20 events, 3 commits of 4 (v1..v3). v2 and v3 are damaged, and v1 holds 4 rows.
   */
  const damaged = async (dir: string, zero: number[], provider = fake(8)) => {
    const s = await seed(dir, 20);
    const data = join(dir, "vectors.lance", "data");
    const files = () => existsSync(data) ? readdirSync(data) : [];
    const perCommit: string[][] = [];
    const put = s.putVectors;
    s.putVectors = async rows => { const had = new Set(files()); await put(rows); perCommit.push(files().filter(f => !had.has(f))); };
    await embedShard(s, provider, { batch: 4, limit: 12 });
    for (const c of zero) for (const f of perCommit[c]) truncateSync(join(data, f), 0);
    return LanceStore.open(dir);   // a fresh store: the damage is on disk, not in a cached handle
  };

  test("a SIGKILL during a write leaves the last commit readable, and the next run resumes", async () => {
    /*
     * What a kill really leaves. Lance writes the data files first and the manifest
     * last, so a killed commit is all or nothing. On m5, 60 kills timed into embed
     * writes always left a table that read, and it read at the last commit that landed.
     * The timing of this kill varies from run to run. The assertions hold for any timing.
     */
    const dir = join(tmp, "killed");
    await seed(dir, 600);
    const src = join(import.meta.dir, "..", "src");
    const child = Bun.spawn(["bun", "-e", `
      const { LanceStore } = await import(${JSON.stringify(join(src, "store", "lance.ts"))});
      const { embedShard } = await import(${JSON.stringify(join(src, "embed.ts"))});
      const s = await LanceStore.open(${JSON.stringify(dir)});
      const put = s.putVectors;
      s.putVectors = async rows => { process.stdout.write("W\\n"); await put(rows); };
      await embedShard(s, { id: "test:fake", embed: async t => t.map(() => Array.from({ length: 1024 }, (_, i) => i + 1)) },
                       { batch: 100 });`], { stdout: "pipe", stderr: "pipe" });
    // Kill once the third write has started: two commits have landed, and the third is in flight.
    const reader = child.stdout.getReader();
    let out = "";
    while ((out.match(/W/g) ?? []).length < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      out += new TextDecoder().decode(value);
    }
    child.kill("SIGKILL");
    await child.exited;
    const after = await LanceStore.open(dir);
    expect(await after.vectorDamage()).toBeNull();
    const rows = (await after.vectorStats())!.rows;
    expect(rows % 100).toBe(0);                  // whole commits only
    expect(rows).toBeGreaterThanOrEqual(200);
    const r = await embedShard(after, { id: "test:fake", embed: async t => t.map(() => Array.from({ length: 1024 }, (_, i) => i + 1)) },
                               { batch: 100 });
    expect(r.already + r.embedded).toBe(600);
  }, 30_000);

  test("the reported state: countRows still answers, a scan does not", async () => {
    const s = await damaged(join(tmp, "d-state"), [1, 2]);
    expect((await s.vectorStats())!.rows).toBe(12);     // manifest-only reads look healthy
    await expect(s.embeddedUids()).rejects.toThrow(/LanceError\(IO\)/);
    expect((await s.counts()).events).toBe(20);
  });

  test("vectorDamage names the version that fails and the newest one that reads", async () => {
    const s = await damaged(join(tmp, "d-diag"), [1, 2]);
    expect(await s.vectorDamage()).toMatchObject({ version: 3, rows: 12, restorable: 1, keep: 4 });
  });

  test("a table that reads, or no table at all, is not damage", async () => {
    const s = await seed(join(tmp, "d-none"), 4);
    expect(await s.vectorDamage()).toBeNull();
    await embedShard(s, fake(8), {});
    expect(await s.vectorDamage()).toBeNull();
  });

  test("without --repair the shard is skipped with the damage attached, and nothing is written", async () => {
    const dir = join(tmp, "d-skip");
    const s = await damaged(dir, [1, 2]);
    const r = await embedShard(s, fake(8), { batch: 4 });
    expect(r.skipped).toMatch(/^vectors table unreadable at v3 — LanceError\(IO\)/);
    expect(r.damage).toMatchObject({ version: 3, restorable: 1, keep: 4 });
    expect(r.repaired).toBeUndefined();
    expect(r.embedded).toBe(0);
    expect(await versionOf(dir)).toBe(3);
  });

  test("a dry run never repairs, even with --repair", async () => {
    const dir = join(tmp, "d-dry");
    const s = await damaged(dir, [1, 2]);
    const r = await embedShard(s, fake(8), { batch: 4, repair: true, dryRun: true });
    expect(r.skipped).toMatch(/unreadable at v3/);
    expect(r.repaired).toBeUndefined();
    expect(await versionOf(dir)).toBe(3);
  });

  test("--repair restores the newest version that reads, and the same run re-embeds the rest", async () => {
    const dir = join(tmp, "d-restore");
    const s = await damaged(dir, [1, 2]);
    const r = await embedShard(s, fake(8), { batch: 4, repair: true });
    expect(r.repaired).toBe("restored");
    expect(r.already).toBe(4);          // what v1 kept
    expect(r.embedded).toBe(16);        // the 8 lost with v2..v3, and the 8 never embedded
    expect(r.skipped).toBeUndefined();
    expect(await s.vectorDamage()).toBeNull();
    expect((await s.embeddedUids()).size).toBe(20);
    expect((await s.counts()).events).toBe(20);
    // restore() wrote a new version on top. The damaged ones are still in the history.
    expect(await versionOf(dir)).toBeGreaterThan(3);
  });

  test("with no version that reads, --repair drops `vectors` and nothing else", async () => {
    const s = await damaged(join(tmp, "d-drop"), [0, 1, 2]);
    expect(await s.vectorDamage()).toMatchObject({ version: 3, restorable: null, keep: 0 });
    const r = await embedShard(s, fake(8), { batch: 4, repair: true });
    expect(r.repaired).toBe("dropped");
    expect(r.embedded).toBe(20);
    expect((await s.embeddedUids()).size).toBe(20);
    expect((await s.counts()).events).toBe(20);
  });

  test("a failure outside `vectors` is rethrown, never repaired", async () => {
    // Nothing is dropped on a guess: if `vectors` still reads, the fault is elsewhere.
    const dir = join(tmp, "d-other");
    const s = await seed(dir, 8);
    await embedShard(s, fake(8), { batch: 4 });
    const v = await versionOf(dir);
    s.unembedded = async () => { throw new Error("events went away"); };
    await expect(embedShard(s, fake(8), { repair: true })).rejects.toThrow("events went away");
    expect(await versionOf(dir)).toBe(v);
  });

  test("the note names the one command that repairs this shard, carrying the run's own flags", () => {
    const sh: ShardEmbedStat = {
      key: "hermes/_unresolved", bank: "hermes", repo: "_unresolved", eligible: 1402, already: 0,
      pending: 0, embedded: 0, failed: 0, model: "ollama:nomic-embed-text", dim: 0, skipped: "…",
      damage: { version: 3, rows: 192, error: "", restorable: 1, keep: 64 },
    };
    const note = damageNote(sh, ["--data-root", "/tmp/scratch root", "--model", "nomic-embed-text"]);
    expect(note[1]).toBe("  relic embed --repair --bank hermes --repo _unresolved --data-root '/tmp/scratch root' --model nomic-embed-text");
    expect(note[2]).toBe("that restores v1 (64 of 192 vectors) and re-embeds the rest");
    expect(damageNote({ ...sh, damage: { ...sh.damage!, restorable: null, keep: 0 } }, [])[2]).toMatch(/drops it/);
    expect(damageNote({ ...sh, repaired: "restored" }, [])).toEqual(
      ["repaired: restored v1 of `vectors`, keeping 64 of 192 rows; v3 did not read"]);
    expect(damageNote({ ...sh, damage: undefined }, [])).toEqual([]);
  });

  test("the CLI prints that command, with --data-root, where it used to print a bare SKIP", async () => {
    const root = join(tmp, "cli-root");
    // Written under the CLI's default model, so the model guard lets the run reach the scan.
    await damaged(shardDirFor(null, root, false, "hermes"), [1, 2], { ...fake(8), id: "ollama:all-minilm" });
    const cli = join(import.meta.dir, "..", "src", "cli.ts");
    const run = (...args: string[]) => {
      const p = Bun.spawnSync(["bun", cli, "embed", "--data-root", root, "--bank", "hermes", "--batch", "4", ...args],
                              { stdout: "pipe", stderr: "pipe" });
      return p.stdout.toString();
    };
    const before = run();
    expect(before).toContain("hermes/_unresolved  SKIP  vectors table unreadable at v3 — LanceError(IO)");
    expect(before).toContain(`relic embed --repair --bank hermes --repo _unresolved --data-root ${root} --batch 4`);
    // --repair, against a provider that cannot answer: the repair is local, and the
    // batches that follow fail and stay pending, as any batch against a dead provider does.
    const after = run("--repair", "--host", "http://127.0.0.1:1");
    expect(after).toContain("repaired: restored v1 of `vectors`, keeping 4 of 12 rows; v3 did not read");
    expect(await (await LanceStore.open(shardDirFor(null, root, false, "hermes"))).vectorDamage()).toBeNull();
  }, 30_000);
});
