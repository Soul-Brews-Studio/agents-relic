import { expect, test, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesSessions, parseHermes } from "../src/shapes/hermes.js";

/**
 * #60: `last_activity_at` exists only on some Hermes 0.19.1 builds (added, reverted and
 * re-added upstream), and a missing column made the walker index 0 sessions with exit 0.
 */

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "relic-hermes-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function makeDb(name: string, opts: { lastActivity?: boolean; messages?: boolean } = {}): string {
  const path = join(dir, name);
  const db = new Database(path);
  db.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, git_branch TEXT, git_repo_root TEXT,
          model TEXT, title TEXT, display_name TEXT, started_at REAL, ended_at REAL
          ${opts.lastActivity ? ", last_activity_at REAL" : ""})`);
  if (opts.messages !== false)
    db.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT,
            tool_name TEXT, timestamp REAL, active INTEGER, compacted INTEGER)`);
  return path;
}

function seed(path: string) {
  const db = new Database(path);
  db.run(`INSERT INTO sessions (id, started_at, ended_at) VALUES ('s1', 100, 200), ('s2', 50, NULL), ('empty', 10, NULL)`);
  const ins = db.prepare(`INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, ?, 0)`);
  ins.run("s1", "user", "hello", 150, 1);
  ins.run("s1", "assistant", "hi", 300, 1);
  ins.run("s1", "assistant", "retired later reply", 999, 0);
  ins.run("s2", "user", "only one", 60, 1);
  ins.run("empty", "user", "retired", 70, 0);
  db.close();
}

describe("hermesSessions", () => {
  test("a DB without last_activity_at still returns its sessions", () => {
    const p = makeDb("no-col.db");
    seed(p);
    const got = hermesSessions(p).sort((a, b) => a.id.localeCompare(b.id));
    expect(got).toEqual([
      { id: "s1", mtime: 300, rows: 2 },
      { id: "s2", mtime: 60, rows: 1 },
    ]);
  });

  test("an inactive message never sets the activity time", () => {
    const p = makeDb("inactive.db", { lastActivity: true });
    seed(p);
    expect(hermesSessions(p).find(s => s.id === "s1")?.mtime).toBe(300);
  });

  test("a schema it cannot read is reported on stderr, not swallowed", () => {
    const p = makeDb("broken.db", { messages: false });
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(hermesSessions(p)).toEqual([]);
      const lines = spy.mock.calls.map(c => String(c[0]));
      expect(lines.some(l => l.includes(p) && l.includes("messages"))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

describe("parseHermes", () => {
  test("parses a session from a DB without last_activity_at", async () => {
    const p = makeDb("parse.db");
    seed(p);
    const parsed = await parseHermes(`${p}#s1`);
    expect(parsed.events.map(e => e.role)).toEqual(["user", "assistant"]);
    expect(parsed.endedAt).toBe(new Date(300_000).toISOString());
  });

  test("a failing session query warns once per DB and error", async () => {
    const p = makeDb("parse-broken.db", { messages: false });
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await parseHermes(`${p}#s1`);
      await parseHermes(`${p}#s2`);
      const hits = spy.mock.calls.map(c => String(c[0])).filter(l => l.includes(p));
      expect(hits).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });
});
