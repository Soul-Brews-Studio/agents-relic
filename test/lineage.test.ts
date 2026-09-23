process.env.TZ = "UTC";

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inferLinks, probe, scanMarks, buildLineage, renderLineage, type LineageNode } from "../src/lineage.js";

/**
 * Claude Code gives a new session id on /clear and on relaunch, and keeps it across
 * /compact. Measured on a real worktree: 04d1d650 -> 17ea9961 -> c506864c were one line
 * of work that `relic session --tree` showed as unrelated neighbours in start order.
 */

const T = (hms: string) => `2026-09-16T${hms}.000Z`;
const ms = (hms: string) => Date.parse(T(hms));
const CWD = "/work/repo";

const user = (id: string, ts: string, text: string, extra: object = {}) =>
  ({ type: "user", sessionId: id, timestamp: T(ts), cwd: CWD, message: { role: "user", content: text }, ...extra });
const asst = (id: string, ts: string, text: string) =>
  ({ type: "assistant", sessionId: id, timestamp: T(ts), cwd: CWD, message: { role: "assistant", content: [{ type: "text", text }] } });
const hook = (id: string, ts: string, source: string) =>
  ({ type: "attachment", sessionId: id, timestamp: T(ts), cwd: CWD,
     attachment: { type: "hook_success", hookName: `SessionStart:${source}`, hookEvent: "SessionStart", content: "" } });
const compact = (id: string, ts: string) =>
  ({ type: "system", subtype: "compact_boundary", sessionId: id, timestamp: T(ts), cwd: CWD });

function write(path: string, recs: object[], mtime?: string) {
  writeFileSync(path, recs.map(r => JSON.stringify(r)).join("\n") + "\n");
  if (mtime) utimesSync(path, new Date(T(mtime)), new Date(T(mtime)));
}

const node = (id: string, o: Partial<LineageNode>): LineageNode => ({
  id, path: `/x/${id}.jsonl`, cwd: CWD, startMs: 0, endMs: 0, mtimeMs: 0, started: null,
  title: null, prompt: null, carries: [], marks: [], agents: null, ...o,
});

describe("inferLinks", () => {
  test("/clear links to the session whose final write is the moment the child began", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("12:00:00"), mtimeMs: ms("12:00:05"), started: "startup" });
    const c = node("c", { startMs: ms("12:00:05"), endMs: ms("13:00:00"), mtimeMs: ms("13:00:00"), started: "clear" });
    expect(inferLinks([p, c])).toEqual([
      { parent: "p", child: "c", kind: "clear", gapMs: 5_000, via: "mtime", ambiguous: false },
    ]);
  });

  test("a copied bank loses mtimes — /clear falls back to the last event", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("12:00:00"), mtimeMs: ms("23:00:00") });
    const c = node("c", { startMs: ms("12:00:40"), endMs: ms("13:00:00"), mtimeMs: ms("23:00:00"), started: "clear" });
    expect(inferLinks([p, c])[0]).toMatchObject({ parent: "p", kind: "clear", via: "last-event", gapMs: 40_000 });
  });

  test("a startup within a minute of the old process exiting is a relaunch, not a /clear", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("10:00:03"), mtimeMs: ms("10:00:10") });
    const c = node("c", { startMs: ms("10:00:20"), endMs: ms("11:00:00"), mtimeMs: ms("11:00:00"), started: "startup" });
    expect(inferLinks([p, c])[0]).toMatchObject({ kind: "relaunch", gapMs: 17_000 });
  });

  test("a session still writing when another starts is a neighbour, never a parent", () => {
    const a = node("a", { startMs: ms("10:00:00"), endMs: ms("12:00:00"), mtimeMs: ms("12:00:00") });
    const b = node("b", { startMs: ms("11:30:00"), endMs: ms("11:45:00"), mtimeMs: ms("11:30:00"), started: "clear" });
    expect(inferLinks([a, b])).toEqual([]);
  });

  test("a startup long after anything ended is a root", () => {
    const a = node("a", { startMs: ms("10:00:00"), endMs: ms("10:05:00"), mtimeMs: ms("10:05:01") });
    const b = node("b", { startMs: ms("11:00:00"), endMs: ms("11:05:00"), mtimeMs: ms("11:05:00"), started: "startup" });
    expect(inferLinks([a, b])).toEqual([]);
  });

  test("one process continues into ONE session — a /clear beats a bare relaunch", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("12:00:00"), mtimeMs: ms("12:00:02") });
    const clear = node("c", { startMs: ms("12:00:02"), endMs: ms("13:00:00"), mtimeMs: ms("13:00:00"), started: "clear" });
    const other = node("o", { startMs: ms("12:00:01"), endMs: ms("12:30:00"), mtimeMs: ms("12:30:00"), started: "startup" });
    const links = inferLinks([p, clear, other]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ parent: "p", child: "c", kind: "clear" });
  });

  test("lines written under another id are an explicit link", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("11:00:00"), mtimeMs: ms("11:00:00") });
    const c = node("c", { startMs: ms("15:00:00"), endMs: ms("16:00:00"), mtimeMs: ms("16:00:00"), started: "resume", carries: ["p"] });
    expect(inferLinks([p, c])[0]).toMatchObject({ parent: "p", child: "c", kind: "fork", via: "ids" });
  });
});

describe("probe", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "relic-lineage-probe-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("no SessionStart hook configured: the /clear turn still marks the start", () => {
    const f = join(dir, "c.jsonl");
    write(f, [
      user("c", "12:00:05", "<local-command-caveat>Caveat</local-command-caveat>", { isMeta: true }),
      user("c", "12:00:05", "<command-name>/clear</command-name>"),
      user("c", "12:00:09", "what came before this?\nsecond line"),
      asst("c", "12:00:20", "reading"),
    ]);
    const n = probe(f, "c");
    expect(n.started).toBe("clear");
    expect(n.prompt).toBe("what came before this?");
    expect(n.startMs).toBe(ms("12:00:05"));
    expect(n.endMs).toBe(ms("12:00:20"));
  });

  test("a custom title beats the host's title, wherever each sits", () => {
    const f = join(dir, "t.jsonl");
    write(f, [
      { type: "custom-title", customTitle: "prune-feature", sessionId: "t" },
      hook("t", "10:00:00", "startup"),
      user("t", "10:00:01", "go"),
      { type: "ai-title", aiTitle: "Some generated name", sessionId: "t" },
    ]);
    expect(probe(f, "t")).toMatchObject({ title: "prune-feature", started: "startup" });
  });

  test("start from the head, end from the tail, across a file bigger than one chunk", () => {
    const f = join(dir, "big.jsonl");
    write(f, [
      hook("big", "09:00:00", "startup"),
      user("big", "09:00:01", "start"),
      asst("big", "10:00:00", "x".repeat(200_000)),
      asst("big", "11:59:59", "end"),
    ]);
    expect(probe(f, "big")).toMatchObject({ startMs: ms("09:00:00"), endMs: ms("11:59:59"), started: "startup" });
  });
});

describe("scanMarks", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "relic-lineage-marks-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a real compact counts; a tool call that merely mentions one does not", async () => {
    const f = join(dir, "m.jsonl");
    write(f, [
      hook("m", "10:00:00", "resume"),
      asst("m", "10:10:00", 'rg -c \'"subtype":"compact_boundary"\' file.jsonl'),
      compact("m", "10:20:00"),
      hook("m", "11:00:00", "resume"),
      hook("m", "11:00:01", "resume"),
    ]);
    expect(await scanMarks(f, ms("10:00:00"))).toEqual([
      { kind: "compact", atMs: ms("10:20:00") },
      { kind: "resume", atMs: ms("11:00:00") },
    ]);
  });
});

describe("buildLineage + renderLineage", () => {
  let dir: string;
  const A = "a1111111-0000-4000-8000-000000000000";
  const B = "b2222222-0000-4000-8000-000000000000";
  const C = "c3333333-0000-4000-8000-000000000000";
  const D = "d4444444-0000-4000-8000-000000000000";

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relic-lineage-build-"));
    write(join(dir, `${A}.jsonl`), [hook(A, "10:00:00", "startup"), user(A, "10:00:01", "ok"), asst(A, "10:00:03", "Ready.")], "10:00:10");
    write(join(dir, `${B}.jsonl`), [
      hook(B, "10:00:20", "startup"), user(B, "10:00:21", "prune the index"),
      compact(B, "11:00:00"), asst(B, "12:00:00", "done"),
      { type: "custom-title", customTitle: "prune-feature", sessionId: B },
    ], "12:00:05");
    write(join(dir, `${C}.jsonl`), [
      hook(C, "12:00:05", "clear"), user(C, "12:00:05", "<command-name>/clear</command-name>"),
      user(C, "12:00:30", "tail the last one"), asst(C, "13:00:00", "here"),
      { type: "ai-title", aiTitle: "Relic tail", sessionId: C },
    ], "13:00:00");
    write(join(dir, `${D}.jsonl`), [hook(D, "11:30:00", "startup"), user(D, "11:30:01", "side quest"), asst(D, "11:45:00", "bye")], "11:45:00");

    const sub = join(dir, B, "subagents");
    mkdirSync(sub, { recursive: true });
    write(join(sub, "agent-anoise-4ce7f04522c3d3e1.jsonl"), [user(B, "10:30:00", "go"), asst(B, "10:40:00", "done")]);
    write(join(sub, "agent-avaults-8e0d699555199713.jsonl"), [user(B, "10:35:00", "go"), asst(B, "10:50:00", "done")]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the chain through the target, drawn as one tree", async () => {
    const l = await buildLineage(dir, C);
    expect(l.nodes.map(n => n.id).sort()).toEqual([A, B, C]);
    expect(renderLineage(l, { now: ms("20:00:00"), current: C }).split("\n")).toEqual([
      "lineage · 3 sessions · /work/repo · UTC+00",
      "",
      'a1111111  09-16 10:00:00 → 10:00:03   3s   "ok"',
      " └─ relaunch 17s later · no marker",
      "    b2222222  09-16 10:00:20 → 12:00:00   2.0h   prune-feature",
      "     ├─ 2 subagents: noise, vaults · 10:30–10:50 · peak 2 at once",
      "     ├─ compact 11:00:00  (same id)",
      "     └─ /clear → new id 5s later",
      "        c3333333  09-16 12:00:05 → 13:00:00   60m   Relic tail   ← you are here",
    ]);
  });

  test("--all adds the unlinked session as its own root", async () => {
    const l = await buildLineage(dir, C, { all: true });
    const out = renderLineage(l, { now: ms("20:00:00") });
    expect(out).toContain("lineage · 4 sessions");
    expect(out).toContain('\nd4444444  09-16 11:30:00 → 11:45:00   15m   "side quest"');
  });

  test("a transcript written in the last five minutes ends at now", async () => {
    const l = await buildLineage(dir, C);
    expect(renderLineage(l, { now: ms("13:02:00"), current: C })).toContain("c3333333  09-16 12:00:05 → now   1.0h");
  });
});

describe("#67 — mtime is not liveness", () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "relic-lineage-67-")); });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("a parent rewritten long after the /clear still links on its last event within 120s", () => {
    const p = node("p", { startMs: ms("10:00:00"), endMs: ms("12:00:00"), mtimeMs: ms("20:00:00") });
    const c = node("c", { startMs: ms("12:01:30"), endMs: ms("13:00:00"), mtimeMs: ms("13:00:00"), started: "clear" });
    expect(inferLinks([p, c])[0]).toMatchObject({ parent: "p", kind: "clear", via: "last-event", gapMs: 90_000 });
    const late = node("c", { ...c, startMs: ms("12:03:00") });
    expect(inferLinks([p, late])).toEqual([]);
  });

  test("a transcript whose first 64 KB holds no timestamp still gets a node", () => {
    const f = join(dir, "big-head.jsonl");
    const snapshot = { type: "file-history-snapshot", messageId: "m", snapshot: { pad: "s".repeat(1_000) } };
    write(f, [
      ...Array.from({ length: 100 }, () => snapshot),
      hook("big-head", "09:00:00", "startup"),
      user("big-head", "09:00:01", "real work"),
      asst("big-head", "09:30:00", "done"),
    ]);
    expect(probe(f, "big-head")).toMatchObject({ startMs: ms("09:00:00"), endMs: ms("09:30:00"), started: "startup" });
  });

  test("a metadata rewrite does not make an idle transcript read as now", async () => {
    const id = "e5555555-0000-4000-8000-000000000000";
    write(join(dir, `${id}.jsonl`), [
      hook(id, "10:00:00", "startup"), user(id, "10:00:01", "work"), asst(id, "11:00:00", "done"),
      { type: "permission-mode", permissionMode: "default", sessionId: id },
    ], "13:01:00");
    const l = await buildLineage(dir, id);
    const out = renderLineage(l, { now: ms("13:02:00") });
    expect(out).toContain("e5555555  09-16 10:00:00 → 11:00:00   1.0h");
    expect(out).not.toContain("→ now");
  });
});
