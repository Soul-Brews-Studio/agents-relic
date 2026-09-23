import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { parseClaude } from "../src/shapes/claude.js";
import { importFiles, sameNameGroups } from "../src/import.js";
import { uidOf, treeKeyOf } from "../src/types.js";
import { LanceStore, type EventRow } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import type { Found } from "../src/discover.js";

// #58: basename-keyed uids let same-named transcripts in one shard overwrite each other's events (31 lost on m5).

const S = "04d1d650-031a-44f6-9c22-3e400e68390f";
const T = "7ef42bea-0000-4000-8000-000000000000";
const CWD = "/opt/Code/github.com/acme/widget";
const PROJ = "-opt-Code-github-com-acme-widget";
const REPO = "github.com/acme/widget";
const BANK = "projects";

const tmp = mkdtempSync(join(tmpdir(), "relic-uid-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const userLine = (sid: string, text: string, i: number) => JSON.stringify({
  type: "user", uuid: `u${i}`, sessionId: sid, cwd: CWD, timestamp: `2026-09-20T00:00:0${i}Z`,
  message: { role: "user", content: text },
}) + "\n";

// Every transcript's texts, keyed by the path relative to the source root.
const FILES: Record<string, { sid: string; texts: string[] }> = {
  [`${S}.jsonl`]: { sid: S, texts: ["parent opens the session", "parent asks for agents"] },
  [`${S}/subagents/agent-a9169933f0b7bf6ca.jsonl`]:
    { sid: S, texts: ["direct subagent first", "direct subagent second", "direct subagent third"] },
  [`${S}/subagents/workflows/wf_3ae64b4d-526/agent-a9169933f0b7bf6ca.jsonl`]:
    { sid: S, texts: ["workflow copy first", "workflow copy second"] },
  [`${S}/subagents/workflows/wf_2eaa3985-0a2/agent-ac19ff7e46a2ad669.jsonl`]:
    { sid: S, texts: ["run under session S"] },
  [`${T}/subagents/workflows/wf_2eaa3985-0a2/agent-ac19ff7e46a2ad669.jsonl`]:
    { sid: T, texts: ["run under session T"] },
};
const ALL_TEXTS = Object.values(FILES).flatMap(f => f.texts);

function tierOf(rel: string): Found["tier"] {
  return rel.includes("/workflows/") ? "workflow_agent" : rel.includes("/subagents/") ? "subagent" : "session";
}

function writeTree(srcRoot: string): Found[] {
  const out: Found[] = [];
  for (const [rel, f] of Object.entries(FILES)) {
    const p = join(srcRoot, PROJ, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, f.texts.map((t, i) => userLine(f.sid, t, i)).join(""));
    const st = statSync(p);
    const wf = rel.match(/workflows\/(wf_[^/]+)\//)?.[1] ?? null;
    out.push({ path: p, projectDir: PROJ, tier: tierOf(rel), source: "claude-live", bank: BANK,
               workflowRunId: wf, agentId: tierOf(rel) === "session" ? null : basename(p, ".jsonl"),
               mtime: Math.floor(st.mtimeMs / 1000), size: st.size, parser: parseClaude });
  }
  return out;
}

async function shape(root: string) {
  const store = await LanceStore.open(shardDirFor(REPO, root, false, BANK));
  const rows = await store.eventsWhere("seq >= 0") as unknown as EventRow[];
  const counted = (await store.sessionStats()).reduce((n, s) => n + s.events, 0);
  return { store, rows, events: rows.length, counted, texts: rows.map(r => r.text) };
}

describe("treeKeyOf", () => {
  test("a top-level transcript keeps its basename, so its uids do not move", () => {
    expect(treeKeyOf(`/r/${PROJ}/${S}.jsonl`)).toBe(`${S}.jsonl`);
    expect(uidOf("claude", "x.jsonl", 7)).toBe("333a68a5473812feb14beeda65a8956819e92cf3");
  });

  test("subagent and workflow-agent keys start at the session dir", () => {
    expect(treeKeyOf(`/r/${PROJ}/${S}/subagents/agent-a1.jsonl`)).toBe(`${S}/subagents/agent-a1.jsonl`);
    expect(treeKeyOf(`/r/${PROJ}/${S}/subagents/workflows/wf_abc/agent-a1.jsonl`))
      .toBe(`${S}/subagents/workflows/wf_abc/agent-a1.jsonl`);
  });

  test("the key is identical across banks and machines with different roots", () => {
    const rel = `${S}/subagents/workflows/wf_abc/agent-a1.jsonl`;
    expect(treeKeyOf(`/Users/a/.claude/projects/${PROJ}/${rel}`))
      .toBe(treeKeyOf(`/home/b/.claude/projects-1sep-tue2026/-home-b-Code-widget/${rel}`));
  });

  test("digests pinned for parity with python/tests/test_parser_parity.py", () => {
    expect(uidOf("claude", treeKeyOf(`/r/-opt-x/${S}/subagents/agent-a1.jsonl`), 7))
      .toBe("72ae4d4171f5d04f2052499fb398aa5d0c006507");
    expect(uidOf("claude", treeKeyOf(`/r/-opt-x/${S}/subagents/workflows/wf_abc/agent-a1.jsonl`), 7))
      .toBe("5515dbe912e947168971651ac564a89d2153c4e2");
  });
});

describe("sameNameGroups", () => {
  test("same file name in two trees is a group", () => {
    const a = `/r/p/${S}/subagents/agent-x.jsonl`, b = `/r/p/${S}/subagents/workflows/wf_1/agent-x.jsonl`;
    expect(sameNameGroups([a, b, `/r/p/${S}.jsonl`])).toEqual([[a, b]]);
  });

  test("one session file in two project dirs is not — the new key cannot separate it, so it must not churn", () => {
    expect(sameNameGroups([`/r/p1/${S}.jsonl`, `/r/p2/${S}.jsonl`])).toEqual([]);
  });
});

describe("importing same-named transcripts into one shard", () => {
  test("every event keeps its own row: count(events) == sum(event_count)", async () => {
    const root = join(tmp, "fresh");
    const found = writeTree(join(tmp, "src-fresh"));
    const t = await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
    expect(t.added).toBe(ALL_TEXTS.length);
    const s = await shape(root);
    expect(s.events).toBe(s.counted);
    expect(s.texts.sort()).toEqual([...ALL_TEXTS].sort());
    for (const text of ALL_TEXTS)
      expect((await s.store.search(text, { limit: 50 })).map(h => h.text)).toContain(text);
  });
});

describe("repairing a shard indexed under the basename uid", () => {
  let root: string, found: Found[];
  let legacyVector: string;

  beforeAll(async () => {
    root = join(tmp, "legacy");
    found = writeTree(join(tmp, "src-legacy"));
    await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });

    // Rewrite the shard the way the old importer left it: basename uids, last writer wins.
    const { store, rows } = await shape(root);
    for (const f of found) await store.deleteEventsOf(f.path);
    for (const f of found) {
      const mine = rows.filter(r => r.file_path === f.path)
        .map(r => ({ ...r, uid: uidOf("claude", basename(r.file_path), Number(r.seq)) }));
      await store.putEvents(mine);
    }
    const nested = found.find(f => f.tier === "workflow_agent")!;
    legacyVector = uidOf("claude", basename(nested.path), 1);
    await store.putVectors([{ uid: legacyVector, embedding: [0.5, 0.5, 0.5, 0.5], model: "test", dim: 4,
                              norm: "l2", embedded_at: "" }]);
  });

  test("the legacy shard reproduces #58: events lost, sessions still counting them", async () => {
    const s = await shape(root);
    expect(s.events).toBeLessThan(s.counted);
  });

  test("the next index re-imports exactly the colliding groups and restores every event", async () => {
    const t = await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
    expect(t.repaired).toBe(4);
    expect(t.skipped).toBe(1);
    const s = await shape(root);
    expect(s.events).toBe(s.counted);
    expect(s.texts.sort()).toEqual([...ALL_TEXTS].sort());
    for (const r of s.rows) expect(r.uid).toBe(uidOf("claude", treeKeyOf(r.file_path), Number(r.seq)));
  });

  test("the re-keyed rows' old vectors are dropped, not orphaned", async () => {
    const { store } = await shape(root);
    expect((await store.embeddedUids()).has(legacyVector)).toBe(false);
  });

  test("a repaired shard is left alone on the next run", async () => {
    const t = await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
    expect(t.repaired).toBe(0);
    expect(t.skipped).toBe(found.length);
  });
});

describe("a re-key killed partway loses nothing (the #90 window)", () => {
  /*
   * The #58 repair re-imports files that are UNCHANGED on disk, so their manifest rows
   * still match. The only sign they needed it is their old rows, and flush() deletes
   * those before it inserts the new ones. A run killed in between used to leave those
   * files skipped as unchanged on every later run, with 7 of these 9 events gone and
   * no run that would ever bring them back.
   *
   * Each case throws at one commit, which ends flush() there exactly as a kill would.
   * Nothing after that commit lands. Wherever the kill falls, ONE plain `index`
   * afterwards must bring back every event on its tree-key uid, drop the legacy vector,
   * and leave a shard that the run after it skips.
   */
  const legacyShard = async (name: string) => {
    const root = join(tmp, name);
    const found = writeTree(join(tmp, `src-${name}`));
    await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
    const { store, rows } = await shape(root);
    for (const f of found) await store.deleteEventsOf(f.path);
    for (const f of found)
      await store.putEvents(rows.filter(r => r.file_path === f.path)
        .map(r => ({ ...r, uid: uidOf("claude", basename(r.file_path), Number(r.seq)) })));
    const nested = found.find(f => f.tier === "workflow_agent")!;
    await store.putVectors([{ uid: uidOf("claude", basename(nested.path), 1), embedding: [0.5, 0.5, 0.5, 0.5],
                              model: "test", dim: 4, norm: "l2", embedded_at: "" }]);
    return { root, found };
  };

  /**
   * Make one store method throw on its nth matching call, as the process dying at that
   * commit. `table` narrows upsert to one table. Returns the undo.
   */
  const killAt = (method: string, table?: string, nth = 1) => {
    const proto = LanceStore.prototype as any, real = proto[method];
    let calls = 0;
    proto[method] = async function (this: unknown, ...args: unknown[]) {
      if ((table === undefined || args[0] === table) && ++calls === nth)
        throw new Error(`killed at ${method}${table ? `(${table})` : ""}`);
      return real.apply(this, args);
    };
    return () => { proto[method] = real; };
  };

  // The batch deletes four files, one commit each: both members of each of the two groups.
  const cases: [string, string, string?, number?][] = [
    ["after the files are marked stale, before any row is deleted", "deleteVectors"],
    ["after the legacy vectors are deleted, before the events", "deleteEventsOf"],
    ["between two files' deletes: one group gone, the other intact", "deleteEventsOf", undefined, 3],
    ["after the event deletes, before the insert (the reported window)", "upsert", "events"],
    ["after the insert, before the session rows", "upsert", "sessions"],
    ["after the session rows, before the files rows", "upsert", "files"],
  ];

  for (const [i, [when, method, table, nth]] of cases.entries()) {
    test(`killed ${when}: the next plain index restores every event`, async () => {
      const { root, found } = await legacyShard(`kill-${i}`);
      const undo = killAt(method, table, nth);
      try {
        await expect(importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false })).rejects.toThrow(/^killed at/);
      } finally { undo(); }

      await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
      const s = await shape(root);
      expect(s.texts.sort()).toEqual([...ALL_TEXTS].sort());
      expect(s.events).toBe(s.counted);
      for (const r of s.rows) expect(r.uid).toBe(uidOf("claude", treeKeyOf(r.file_path), Number(r.seq)));
      expect((await s.store.embeddedUids()).size).toBe(0);

      const again = await importFiles(found, { dataRoot: root, inRepo: false, skipNoise: false });
      expect(again.imported).toBe(0);
      expect(again.skipped).toBe(found.length);
    });
  }
});
