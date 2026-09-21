import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";
import { checkGenericQuery, searchEvents } from "../src/query.js";
import { BANKS_DIR, DEFAULT_BANK } from "../src/repo.js";

/*
 * #32 — integration coverage over checkGenericQuery/searchEvents, against REAL
 * LanceDB shards (built the same way test/prune.test.ts does: putEvents directly,
 * no parser needed). pure.test.ts covers the threshold decision itself
 * (decideGeneric) and the term extraction (contentTerms) without any I/O; this file
 * covers the part that actually samples shards and the CLI's --no-warn wiring
 * through searchEvents' `warnGeneric` option.
 *
 * Corpus shape, chosen to control document frequency exactly:
 *   - 15 shards total (under GENERIC_SAMPLE_SHARDS=40, so every shard is sampled —
 *     no stratification noise to account for).
 *   - "run"/"agent"/"pane" appear >=3 times (GENERIC_PROBE_LIMIT) in ALL 15 shards
 *     -> df = 1.00, common.
 *   - "devicectl" appears once, in 2 of 15 shards -> df = 0.00 (below the probe
 *     limit even where present) — the rare-identifier case.
 */
const tmp = mkdtempSync(join(tmpdir(), "relic-generic-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

let nextUid = 0;
const ev = (text: string) => ({
  uid: `u${nextUid++}`, session_uuid: "s", file_path: "/f.jsonl", repo_key: "r", seq: 1,
  role: "user", ts: "2026-09-22T00:00:00Z", text,
  source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "",
  org: "", project: "", dir: "", mem_type: "", origin_session: "",
});

const COMMON = "run the agent in a pane and watch it run, pane by pane, agent by agent";
const shardDirs: { dir: string }[] = [];

async function buildCorpus() {
  for (let i = 0; i < 15; i++) {
    const dir = join(tmp, BANKS_DIR, DEFAULT_BANK, "github.com", "org", `repo-${i}`);
    mkdirSync(dir, { recursive: true });
    const store = await LanceStore.open(dir);
    const events = [ev(COMMON), ev(COMMON), ev(COMMON), ev("nothing else notable here")];
    if (i < 2) events.push(ev("devicectl reported a fault on the bench"));
    await store.putEvents(events);
    shardDirs.push({ dir });
  }
}
await buildCorpus();

describe("checkGenericQuery — sampled against real shards", () => {
  test("fires on a query where every content term is common", async () => {
    const r = await checkGenericQuery("run agent pane", shardDirs);
    expect(r).not.toBeNull();
    expect(r!.warn).toBe(true);
    expect(r!.terms.map(t => t.term).sort()).toEqual(["agent", "pane", "run"]);
    for (const t of r!.terms) expect(t.df).toBeGreaterThan(0.15);
  });

  test("does NOT fire when one term is rare — it anchors the query", async () => {
    // devicectl sits at df=0 (present in only 2/15 shards, and only once per shard —
    // below GENERIC_PROBE_LIMIT even there), so this must not warn despite "run" and
    // "agent" both being common.
    const r = await checkGenericQuery("devicectl run agent", shardDirs);
    expect(r).not.toBeNull();
    expect(r!.warn).toBe(false);
    expect(r!.rarest).toBe("devicectl");
  });

  test("a single term never warns — nothing to union against", async () => {
    const r = await checkGenericQuery("run", shardDirs);
    expect(r).toBeNull();
  });

  test("an all-stopword query never warns — no content terms to check", async () => {
    const r = await checkGenericQuery("the of in", shardDirs);
    expect(r).toBeNull();
  });
});

describe("searchEvents — the --no-warn wiring (warnGeneric option)", () => {
  test("generic is populated by default", async () => {
    const r = await searchEvents("run agent pane", { dataRoot: tmp });
    expect(r.generic).toBeDefined();
    expect(r.generic!.warn).toBe(true);
  });

  test("warnGeneric:false (--no-warn) suppresses the check entirely", async () => {
    const r = await searchEvents("run agent pane", { dataRoot: tmp, warnGeneric: false });
    expect(r.generic).toBeUndefined();
  });

  test("a specific query does not carry a warning, suppressed or not", async () => {
    const r = await searchEvents("devicectl run agent", { dataRoot: tmp });
    expect(r.generic).toBeDefined();
    expect(r.generic!.warn).toBe(false);
  });
});
