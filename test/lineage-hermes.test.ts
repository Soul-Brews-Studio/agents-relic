process.env.TZ = "UTC";

import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesLinks, readHermes, findHermesSessions, buildHermesLineage, type HermesRow } from "../src/lineage-hermes.js";
import { renderLineage } from "../src/lineage.js";

// #74: a shared session_key is one line; parent_session_id is a parallel spawn, never continuation.

const T0 = Date.parse("2026-08-03T08:00:00Z") / 1000;
const MAIN = "20260803_080012_70db8ef0";
const KEY = "agent:main:discord:group:chan:user";

const row = (id: string, o: Partial<HermesRow>): HermesRow =>
  ({ id, sessionKey: null, parentId: null, startMs: 0, endMs: 0, cwd: null, title: null, prompt: null, ...o });

describe("hermesLinks", () => {
  test("13 parallel children of one parent never fuse into a line", () => {
    const rows = [
      row("p", { sessionKey: KEY, startMs: 0, endMs: 1000 }),
      ...Array.from({ length: 13 }, (_, i) => row(`c${i}`, { parentId: "p", sessionKey: KEY, startMs: 10 + i, endMs: 500 })),
    ];
    const { links, childrenOf } = hermesLinks(rows);
    expect(links).toEqual([]);
    expect(childrenOf.get("p")).toHaveLength(13);
  });

  test("a shared non-empty key chains in start order; an empty key never links", () => {
    const rows = [
      row("b", { sessionKey: KEY, startMs: 5000, endMs: 6000 }),
      row("a", { sessionKey: KEY, startMs: 1000, endMs: 2000 }),
      row("x", { sessionKey: "", startMs: 2500, endMs: 3000 }),
      row("y", { sessionKey: null, startMs: 2600, endMs: 3100 }),
    ];
    expect(hermesLinks(rows).links).toEqual([
      { parent: "a", child: "b", kind: "session_key", gapMs: 3000, via: "ids", ambiguous: false },
    ]);
  });

  test("a child whose parent is not in the DB stands on its own line", () => {
    const { links, childrenOf } = hermesLinks([
      row("a", { sessionKey: KEY, startMs: 0, endMs: 10 }),
      row("orphan", { parentId: "gone", sessionKey: KEY, startMs: 20, endMs: 30 }),
    ]);
    expect(childrenOf.size).toBe(0);
    expect(links).toHaveLength(1);
  });
});

describe("readHermes + buildHermesLineage", () => {
  let dir: string, db: string, old: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relic-lineage-hermes-"));
    mkdirSync(join(dir, "profiles", "ting"), { recursive: true });
    db = join(dir, "profiles", "ting", "state.db");
    const d = new Database(db);
    d.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT, parent_session_id TEXT,
           cwd TEXT, git_repo_root TEXT, title TEXT, display_name TEXT, started_at REAL, ended_at REAL)`);
    d.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
           timestamp REAL, active INTEGER)`);
    const s = d.prepare(`INSERT INTO sessions (id, session_key, parent_session_id, title, started_at) VALUES (?, ?, ?, ?, ?)`);
    const m = d.prepare(`INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)`);
    s.run(MAIN, KEY, null, "book sprint", T0);
    m.run(MAIN, "user", "write the book\nplease", T0 + 5);
    m.run(MAIN, "assistant", "on it", T0 + 600);
    for (let i = 0; i < 13; i++) {
      const id = `20260803_0801${String(i).padStart(2, "0")}_child${i}`;
      s.run(id, KEY, MAIN, `chapter ${i + 1}`, T0 + 60 + i);
      m.run(id, "user", "write a chapter", T0 + 61 + i);
      m.run(id, "assistant", "done", T0 + 300);
    }
    s.run("20260807_203327_7c42bddb", KEY, null, null, T0 + 4 * 86400);
    m.run("20260807_203327_7c42bddb", "user", "continue", T0 + 4 * 86400 + 10);
    old = "20260805_101010_00000000";
    s.run(old, "", null, "unrelated", T0 + 2 * 86400);
    m.run(old, "user", "side quest", T0 + 2 * 86400 + 1);
    d.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("children fold under the parent, the key links the next session, the keyless one stays out", () => {
    const l = buildHermesLineage(db, "20260807_203327_7c42bddb");
    expect(l.nodes.map(n => n.id)).toEqual([MAIN, "20260807_203327_7c42bddb"]);
    expect(l.links).toHaveLength(1);
    expect(l.nodes[0].agents).toMatchObject({ subagents: 13, peak: 13 });
    expect(renderLineage(l, { now: (T0 + 10 * 86400) * 1000 }).split("\n")).toEqual([
      `lineage · 2 sessions · ${db} · UTC+00`,
      "",
      "20260803_080012_70db8ef0  08-03 08:00:00 → 08:10:00   10m   book sprint",
      " ├─ 13 subagents · 08:01–08:05 · peak 13 at once",
      " └─ same session_key → new id 95.8h later",
      '    20260807_203327_7c42bddb  08-07 08:00:00 → 08:00:10   10s   "continue"',
    ]);
  });

  test("a spawned child resolves to its parent's line", () => {
    const l = buildHermesLineage(db, "20260803_080105_child5");
    expect(l.nodes.map(n => n.id)).toEqual([MAIN, "20260807_203327_7c42bddb"]);
  });

  test("an optional column missing from the schema is tolerated", () => {
    const bare = join(dir, "bare.db");
    const d = new Database(bare);
    d.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, started_at REAL)`);
    d.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)`);
    d.run(`INSERT INTO sessions VALUES ('s1', ${T0})`);
    d.close();
    expect(readHermes(bare)).toMatchObject([{ id: "s1", sessionKey: null, parentId: null }]);
  });

  test("ids are found by prefix across the DBs under a root", () => {
    expect(findHermesSessions("20260807", [dir])).toEqual([{ id: "20260807_203327_7c42bddb", db }]);
    expect(findHermesSessions("20260803_0801", [dir])).toHaveLength(13);
  });
});
