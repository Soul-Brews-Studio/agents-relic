import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";
import { shardKeyFor, splitShardKey, Shards, importFiles, type ImportTally } from "../src/import.js";
import type { Found } from "../src/discover.js";
import { prune, pruneRefusal, pruneTotals, DEFAULT_MAX_DROP_PCT } from "../src/prune.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-prune-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const ev = (uid: string, file_path: string) => ({
  uid, session_uuid: "s", file_path, repo_key: "r", seq: 1, role: "user", ts: "", text: "hi",
  source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
  org: "", project: "", dir: "", mem_type: "", origin_session: "",
});
const se = (file_path: string) => ({
  session_uuid: "s", file_path, repo_key: "r", project_dir: "p", tier: "session", source: "claude",
  cwd: "", model: "", worktree: "", workflow_run_id: "", agent_id: "",
  file_mtime: 1, file_size: 2, line_count: 1, event_count: 1, bad_lines: 0,
  started_at: "", ended_at: "", description: "", title: "", git_branch: "", imported_at: "",
});
const fi = (file_path: string) => ({ file_path, repo_key: "r", mtime: 1, size: 2, imported_at: "" });

describe("shard key is one rule", () => {
  test("round-trips, and a null repo becomes _unresolved", () => {
    expect(splitShardKey(shardKeyFor("projects", "github.com/a/b")))
      .toEqual({ bank: "projects", repo: "github.com/a/b" });
    expect(splitShardKey(shardKeyFor("codex", null)))
      .toEqual({ bank: "codex", repo: "_unresolved" });
  });
  test("the separator cannot appear in either part", () => {
    // NUL is what makes the key unambiguous. A "/" separator would collide the moment
    // a bank name contained one, and both parts are user-reachable strings.
    expect(shardKeyFor("a", "b")).toContain("\u0000");
  });
});

describe("indexedFiles", () => {
  test("a file with ZERO events still counts — that is the whole bug", async () => {
    /*
     * journal.jsonl parses to zero events, so it writes a session row and a file row
     * and NO event rows. 1,353 of them sat in the live index. Reading only `events`
     * to decide what is indexed would report this shard as already clean.
     */
    const store = await LanceStore.open(join(tmp, "zero-events"));
    await store.putEvents([ev("u1", "/a/chat.jsonl")]);
    await store.putSessions([se("/a/chat.jsonl"), se("/a/journal.jsonl")]);
    await store.putFiles([fi("/a/chat.jsonl"), fi("/a/journal.jsonl")]);
    expect([...await store.indexedFiles()].sort()).toEqual(["/a/chat.jsonl", "/a/journal.jsonl"]);
  });
});

describe("pruneFiles", () => {
  test("the dry run and the real run report the same numbers", async () => {
    const store = await LanceStore.open(join(tmp, "counts"));
    await store.putEvents([ev("u1", "/keep.jsonl"), ev("u2", "/drop.jsonl"), ev("u3", "/drop.jsonl")]);
    await store.putSessions([se("/keep.jsonl"), se("/drop.jsonl")]);
    await store.putFiles([fi("/keep.jsonl"), fi("/drop.jsonl")]);

    const dry = await store.pruneFiles(["/drop.jsonl"], false);
    expect(dry).toEqual({ events: 2, sessions: 1, files: 1, vectors: 0 });
    // Still there — a dry run that deletes is the failure this pins.
    expect((await store.indexedFiles()).has("/drop.jsonl")).toBe(true);

    const real = await store.pruneFiles(["/drop.jsonl"], true);
    expect(real).toEqual(dry);
    expect([...await store.indexedFiles()]).toEqual(["/keep.jsonl"]);
  });

  test("vectors go with their events, not after them", async () => {
    /*
     * `vectors` is keyed on uid and reaches a file ONLY through events.uid. Delete the
     * events first and every embedding is stranded with nothing left to find it by —
     * and stranded rows are invisible, because vectorStats() counts rows, not
     * reachable ones. This pins the ordering inside pruneFiles.
     */
    const store = await LanceStore.open(join(tmp, "vectors"));
    await store.putEvents([ev("u1", "/keep.jsonl"), ev("u2", "/drop.jsonl")]);
    await store.putFiles([fi("/keep.jsonl"), fi("/drop.jsonl")]);
    await store.putVectors([
      { uid: "u1", embedding: [1, 0], model: "t", dim: 2, norm: "l2", embedded_at: "" },
      { uid: "u2", embedding: [0, 1], model: "t", dim: 2, norm: "l2", embedded_at: "" },
    ]);
    expect((await store.vectorStats())?.rows).toBe(2);

    const r = await store.pruneFiles(["/drop.jsonl"], true);
    expect(r.vectors).toBe(1);
    expect((await store.vectorStats())?.rows).toBe(1);
    expect([...await store.embeddedUids()]).toEqual(["u1"]);
  });

  test("an empty path list touches nothing", async () => {
    const store = await LanceStore.open(join(tmp, "empty"));
    await store.putFiles([fi("/a")]);
    expect(await store.pruneFiles([], true)).toEqual({ events: 0, sessions: 0, files: 0, vectors: 0 });
    expect((await store.indexedFiles()).size).toBe(1);
  });
});

describe("the gates — what prune refuses", () => {
  const tally = (over: Partial<ImportTally> = {}): ImportTally => ({
    added: 0, skipped: 0, failed: 0, filtered: 0, skippedNoise: 0, done: 0, imported: 0,
    shards: new Shards(null), seen: new Map(), ftsBuilt: 0, ftsFailed: 0, ftsMs: 0, ...over,
  });

  test("--since: an older file is not a deleted file", () => {
    expect(pruneRefusal(tally(), { sinceMs: Date.now() - 1000, repoFilter: null }))
      .toMatch(/--since narrows discovery/);
  });
  test("--repo: another repo is not a deleted repo", () => {
    expect(pruneRefusal(tally(), { sinceMs: null, repoFilter: "neo-oracle" }))
      .toMatch(/--repo narrows discovery/);
  });
  test("a parse failure blocks the whole run", () => {
    // A file that threw was DISCOVERED. It is present on disk and absent from `seen`,
    // which is indistinguishable from deleted — so one transient failure would delete
    // a live session's rows.
    expect(pruneRefusal(tally({ failed: 1 }), { sinceMs: null, repoFilter: null }))
      .toMatch(/failed to parse/);
  });
  test("a full clean scan is allowed", () => {
    expect(pruneRefusal(tally(), { sinceMs: null, repoFilter: null })).toBeNull();
  });
});

describe("prune over shards", () => {
  const opts = (over: any = {}) => ({
    apply: false, maxDropPct: DEFAULT_MAX_DROP_PCT, force: false,
    dataRoot: join(tmp, "no-such-root"), inRepo: false, sinceMs: null, repoFilter: null, ...over,
  });

  /** A tally whose pool holds one real store under one shard key. */
  async function oneShard(dir: string, indexed: string[], discovered: string[]) {
    const store = await LanceStore.open(join(tmp, dir));
    await store.putEvents(indexed.map((p, i) => ev(`u${i}`, p)));
    await store.putSessions(indexed.map(se));
    await store.putFiles(indexed.map(fi));
    const key = shardKeyFor("projects", "github.com/a/b");
    const shards = new Shards(null);
    (shards as any).pool.set(key, store);
    const t: ImportTally = {
      added: 0, skipped: 0, failed: 0, filtered: 0, skippedNoise: 0, done: 0, imported: 0,
      shards, seen: new Map([[key, new Set(discovered)]]), ftsBuilt: 0, ftsFailed: 0, ftsMs: 0,
    };
    return { store, t };
  }

  test("drops exactly what discovery stopped yielding", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `/f${i}.jsonl`);
    const { store, t } = await oneShard("plan", files, files.slice(1));   // 1 of 20 = 5%
    const plan = await prune(t, opts({ apply: true }));
    expect(plan.refused).toBeNull();
    expect(plan.shards[0].drop).toEqual(["/f0.jsonl"]);
    expect(pruneTotals(plan)).toMatchObject({ files: 1, events: 1, sessions: 1, shards: 1 });
    expect((await store.indexedFiles()).has("/f0.jsonl")).toBe(false);
  });

  test("the ceiling refuses a shard, and refusing leaves it untouched", async () => {
    /*
     * The bug this gate exists for: ghq.root was unset on white.local, so
     * resolveRepoKey returned null for every file and everything sharded to
     * _unresolved. Gates 1-3 all pass in that state and the index deletes itself
     * while printing a clean summary.
     */
    const files = Array.from({ length: 20 }, (_, i) => `/f${i}.jsonl`);
    const { store, t } = await oneShard("ceiling", files, files.slice(0, 5));   // 75% gone
    const plan = await prune(t, opts({ apply: true }));
    expect(plan.shards[0].blocked).toMatch(/ceiling 10%/);
    expect(plan.shards[0].removed).toBeNull();
    expect((await store.indexedFiles()).size).toBe(20);
    expect(pruneTotals(plan)).toMatchObject({ files: 0, blocked: 1 });
  });

  test("--force gets past the ceiling", async () => {
    const files = Array.from({ length: 20 }, (_, i) => `/f${i}.jsonl`);
    const { store, t } = await oneShard("forced", files, files.slice(0, 5));
    const plan = await prune(t, opts({ apply: true, force: true }));
    expect(plan.shards[0].blocked).toBeNull();
    expect(plan.shards[0].drop.length).toBe(15);
    expect((await store.indexedFiles()).size).toBe(5);
  });

  test("a clean shard reports nothing rather than erroring", async () => {
    const files = ["/a.jsonl", "/b.jsonl"];
    const { t } = await oneShard("clean", files, files);
    const plan = await prune(t, opts({ apply: true }));
    expect(plan.shards[0].drop).toEqual([]);
    expect(pruneTotals(plan)).toMatchObject({ files: 0, shards: 0, blocked: 0 });
  });

  test("a refused run looks at no shard at all", async () => {
    const files = ["/a.jsonl", "/b.jsonl"];
    const { store, t } = await oneShard("refused", files, []);
    const plan = await prune(t, opts({ apply: true, repoFilter: "x" }));
    expect(plan.refused).toMatch(/--repo/);
    expect(plan.shards).toEqual([]);
    expect((await store.indexedFiles()).size).toBe(2);
  });
});

describe("importFiles --noWrite is what prune scans with", () => {
  /*
   * THE TEST THAT WOULD HAVE CAUGHT THE FIRST VERSION.
   *
   * The run-wide `seen` map was added beside a loop-local `const seen = man.get(...)`.
   * A second block-scoped const puts the outer binding in the temporal dead zone for
   * the WHOLE block, so every file threw ReferenceError — and the importer catches per
   * file and counts it as a parse failure. `bun test` stayed green (138 pass) because
   * nothing called importFiles end to end; a full scan reported 206,639 of 206,639
   * files failed, which only prune's gate 2 made visible.
   *
   * Assert failed === 0 explicitly. A run where everything throws still produces an
   * empty `seen`, an empty plan and a clean-looking "nothing to prune".
   */
  const found = (path: string, bank: string, cwd: string | null): Found => ({
    path, projectDir: "p", tier: "session", source: "claude",
    workflowRunId: null, agentId: null, mtime: 1, size: 2, bank,
    parser: async () => ({
      sessionUuid: "s", cwd, model: "", lines: 1, badLines: 0,
      startedAt: "", endedAt: "", description: "", title: "", gitBranch: "",
      events: [{ uid: "u1", seq: 1, role: "user", ts: "", text: "hello" }],
    }),
  } as unknown as Found);

  test("resolves every file to a shard, writes nothing, and fails none", async () => {
    const root = join(tmp, "nowrite-root");
    const t = await importFiles(
      [found("/x/a.jsonl", "projects", null), found("/x/b.jsonl", "projects", null)],
      { dataRoot: root, inRepo: false, noWrite: true });

    expect(t.failed).toBe(0);
    expect(t.added).toBe(0);
    expect(t.imported).toBe(0);
    expect([...t.seen.values()].flatMap(v => [...v]).sort()).toEqual(["/x/a.jsonl", "/x/b.jsonl"]);

    // Nothing written: the shard has no rows to find.
    const store = t.shards.byKey(shardKeyFor("projects", null))!;
    expect(store).toBeDefined();
    expect((await store.indexedFiles()).size).toBe(0);
  });

  test("a write run marks the same files seen, including ones it skips as unchanged", async () => {
    const root = join(tmp, "write-root");
    const files = [found("/y/a.jsonl", "projects", null), found("/y/b.jsonl", "projects", null)];
    const first = await importFiles(files, { dataRoot: root, inRepo: false });
    expect(first.failed).toBe(0);
    expect(first.imported).toBe(2);

    // Second run: both unchanged, so both are SKIPPED — and both must still be seen,
    // or prune would read "not written this run" as "gone from disk".
    const second = await importFiles(files, { dataRoot: root, inRepo: false });
    expect(second.skipped).toBe(2);
    expect(second.imported).toBe(0);
    expect([...second.seen.values()].flatMap(v => [...v]).sort()).toEqual(["/y/a.jsonl", "/y/b.jsonl"]);

    const plan = await prune(second, { apply: true, maxDropPct: DEFAULT_MAX_DROP_PCT,
      force: false, dataRoot: root, inRepo: false, sinceMs: null, repoFilter: null });
    expect(pruneTotals(plan)).toMatchObject({ files: 0 });
  });
});

describe("a file that moved SHARD is still on disk", () => {
  /*
   * MEASURED ON THE LIVE INDEX, and it is why prune compares against one global set.
   *
   * Two memory notes had rows in `memory/_unresolved` and now resolve to
   * `memory/github.com/laris-co/neo-oracle` — a memory note takes its cwd from the
   * session that produced it, and that session was not indexed yet when the note was
   * first written. Per-shard comparison called both DELETED. Both are on disk, and a
   * prune-only run writes no replacement, so the file would have been left with
   * nothing in the index pointing at it.
   */
  test("its old shard keeps the row; only a file gone EVERYWHERE is dropped", async () => {
    const moved = "/m/note.md";
    const gone  = "/m/journal.jsonl";
    const old = await LanceStore.open(join(tmp, "moved-old"));
    await old.putEvents([ev("u1", moved)]);
    await old.putSessions([se(moved), se(gone)]);
    await old.putFiles([fi(moved), fi(gone)]);

    const oldKey = shardKeyFor("memory", null);                        // _unresolved
    const newKey = shardKeyFor("memory", "github.com/laris-co/neo-oracle");
    const fresh = await LanceStore.open(join(tmp, "moved-new"));
    const shards = new Shards(null);
    (shards as any).pool.set(oldKey, old);
    (shards as any).pool.set(newKey, fresh);

    const t: ImportTally = {
      added: 0, skipped: 0, failed: 0, filtered: 0, skippedNoise: 0, done: 0, imported: 0,
      shards,
      // The file was discovered — but under the NEW shard, not the old one.
      seen: new Map([[oldKey, new Set<string>()], [newKey, new Set([moved])]]),
      ftsBuilt: 0, ftsFailed: 0, ftsMs: 0,
    };
    const plan = await prune(t, { apply: true, maxDropPct: 100, force: false,
      dataRoot: join(tmp, "no-such-root"), inRepo: false, sinceMs: null, repoFilter: null });

    const oldPlan = plan.shards.find(x => x.repo === "_unresolved")!;
    expect(oldPlan.drop).toEqual([gone]);            // NOT the moved file
    expect([...await old.indexedFiles()].sort()).toEqual([moved]);
  });
});
