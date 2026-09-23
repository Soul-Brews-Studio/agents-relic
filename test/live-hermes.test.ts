import { expect, test, describe, beforeAll, afterAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hermesLive, hermesSessionsIn, sameCheckout, hermesPredecessor, hermesCurrent } from "../src/live-hermes.js";
import { encodeProjectDir } from "../src/live.js";

/**
 * #100: Hermes keeps no transcript file, so the project-dir sweep behind `now --all` and
 * the encoded-cwd lookup behind a no-argument `tail`/`recap` never saw it. Reported live:
 * `relic live --all` said "nothing written" while a Hermes conversation was running.
 */

const NOW = Date.now();
const S = (agoSec: number) => NOW / 1000 - agoSec;          // Hermes stores REAL unix seconds

// realpath: macOS hands out /var/... for a tmpdir that a child process reports as /private/var/...
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "relic-live-hermes-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Sess { id: string; key?: string; cwd?: string | null; root?: string | null; parent?: string | null; title?: string | null;
                 msgs: { role: string; text: string; ago: number }[] }

function makeDb(path: string, sessions: Sess[]) {
  mkdirSync(join(path, ".."), { recursive: true });
  const d = new Database(path);
  d.run(`CREATE TABLE sessions (id TEXT PRIMARY KEY, session_key TEXT, parent_session_id TEXT, cwd TEXT,
         git_branch TEXT, git_repo_root TEXT, model TEXT, title TEXT, display_name TEXT, started_at REAL, ended_at REAL)`);
  d.run(`CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, tool_name TEXT,
         timestamp REAL, active INTEGER, compacted INTEGER)`);
  const s = d.prepare(`INSERT INTO sessions (id, session_key, parent_session_id, cwd, git_repo_root, title, started_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const m = d.prepare(`INSERT INTO messages (session_id, role, content, timestamp, active, compacted) VALUES (?, ?, ?, ?, 1, 0)`);
  for (const x of sessions) {
    s.run(x.id, x.key ?? null, x.parent ?? null, x.cwd ?? null, x.root ?? null, x.title ?? null,
          S(Math.max(...x.msgs.map(g => g.ago)) + 5));
    for (const g of x.msgs) m.run(x.id, g.role, g.text, S(g.ago));
  }
  d.close();
}

/** Two exchanges ending `ago` seconds back — enough for `tail` to count it as a real session. */
const talk = (ago: number, what: string) => [
  { role: "user", text: `please ${what}`, ago: ago + 60 }, { role: "assistant", text: "on it", ago: ago + 50 },
  { role: "user", text: `and finish ${what}`, ago: ago + 10 }, { role: "assistant", text: `${what} done`, ago },
];

describe("sameCheckout", () => {
  const R = "/nonexistent-relic-test/github.com/acme/widget";

  test("the same repo and worktree match, down to a subdirectory", () => {
    expect(sameCheckout(R, R)).toBe(true);
    expect(sameCheckout(`${R}/src`, R)).toBe(true);
    expect(sameCheckout(`${R}/wt/a/src`, `${R}/wt/a`)).toBe(true);
  });

  test("a sibling worktree of the same repo is a different checkout", () => {
    expect(sameCheckout(`${R}/wt/a`, `${R}/wt/b`)).toBe(false);
    expect(sameCheckout(`${R}/wt/a`, R)).toBe(false);
  });

  test("another repo never matches", () => {
    expect(sameCheckout("/nonexistent-relic-test/github.com/acme/gadget", R)).toBe(false);
  });

  test("outside any repo the path must match exactly", () => {
    expect(sameCheckout("/nonexistent-relic-test/scratch", "/nonexistent-relic-test/scratch/")).toBe(true);
    expect(sameCheckout("/nonexistent-relic-test/scratch/sub", "/nonexistent-relic-test/scratch")).toBe(false);
  });
});

describe("hermesLive and hermesSessionsIn over a synthetic state.db", () => {
  const root = join(tmp, "unit-hermes");
  const db = join(root, "profiles", "p", "state.db");
  const REPO = "/nonexistent-relic-test/github.com/acme/widget";
  const [LIVE, SPAWN, STALE, GATEWAY, SIBLING] =
    ["20260923_100000_a1a1a1", "20260923_100100_a2a2a2", "20260923_080000_a3a3a3", "20260923_095900_a4a4a4",
     "20260923_100200_a5a5a5"];

  beforeAll(() => makeDb(db, [
    { id: LIVE, root: REPO, title: "live one", msgs: talk(60, "a") },
    { id: SPAWN, root: REPO, parent: LIVE, msgs: talk(20, "b") },
    { id: STALE, root: REPO, msgs: talk(7200, "c") },
    { id: GATEWAY, msgs: talk(90, "d") },                          // Discord: no cwd at all
    { id: SIBLING, root: `${REPO}/wt/other`, msgs: talk(5, "e") },
  ]));

  test("a session inside the window is listed, one outside it is dropped", () => {
    const rows = hermesLive(600, [root], NOW);
    expect(rows.map(r => r.sessionUuid).sort()).toEqual([GATEWAY, LIVE, SIBLING].sort());
    const live = rows.find(r => r.sessionUuid === LIVE)!;
    expect(live).toMatchObject({ source: "hermes", projectDir: db, cwd: REPO, title: "live one", files: [] });
  });

  test("a spawn is its parent's live agent, not a row of its own", () => {
    const live = hermesLive(600, [root], NOW).find(r => r.sessionUuid === LIVE)!;
    expect(live.agents).toBe(1);
    // The fresher child sets the parent's clock, as a live subagent does for a transcript.
    expect(live.eventAgeSec).toBe(20);
  });

  test("a session with no cwd is still live — the window is machine-wide", () => {
    expect(hermesLive(600, [root], NOW).find(r => r.sessionUuid === GATEWAY)?.cwd).toBeNull();
  });

  test("tail candidates: this checkout only, no spawns, newest first", () => {
    expect(hermesSessionsIn(REPO, [root], {}).map(h => h.id)).toEqual([LIVE, STALE]);
    expect(hermesSessionsIn(REPO, [root], {})[0].path).toBe(`${db}#${LIVE}`);
  });

  test("the caller's own Hermes session is never its own predecessor", () => {
    expect(hermesSessionsIn(REPO, [root], { HERMES_SESSION_ID: LIVE }).map(h => h.id)).toEqual([STALE]);
  });

  test("an unreadable DB is skipped, not thrown", () => {
    const bad = join(tmp, "unit-bad");
    mkdirSync(join(bad, "profiles", "x"), { recursive: true });
    writeFileSync(join(bad, "profiles", "x", "state.db"), "not a database");
    const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(hermesLive(600, [bad], NOW)).toEqual([]);
      expect(hermesSessionsIn(REPO, [bad], {})).toEqual([]);
      // Skipped, but never silently: the DB is named once on stderr.
      expect(spy.mock.calls.map(c => String(c[0])).some(l => l.includes(bad))).toBe(true);
    } finally { spy.mockRestore(); }
  });
});

describe("a Hermes caller's own line: hermesPredecessor and hermesCurrent", () => {
  // Two gateway sessions on one session_key — a Discord thread that rolled over — plus a
  // spawn of the newer one and a keyless session. None records a cwd.
  const root = join(tmp, "unit-chain");
  const db = join(root, "profiles", "ting", "state.db");
  const KEY = "agent:main:discord:thread:1:1";
  const [OLDER, NEWER, KID, LONE] =
    ["20260923_080000_c0c0c1", "20260923_110000_c0c0c2", "20260923_110500_c0c0c3", "20260923_120000_c0c0c4"];

  beforeAll(() => makeDb(db, [
    { id: OLDER, key: KEY, title: "the relay", msgs: talk(3 * 3600, "the relay") },
    { id: NEWER, key: KEY, msgs: talk(900, "a follow-up") },
    { id: KID, key: KEY, parent: NEWER, msgs: talk(600, "a chapter") },
    { id: LONE, key: "", msgs: talk(60, "a side quest") },
  ]));

  test("the newer session's predecessor is the one before it on the key", () => {
    expect(hermesPredecessor(NEWER, [root])).toEqual({ id: OLDER, path: `${db}#${OLDER}` });
  });

  test("the first of a line, a spawn, a keyless session and an unknown id have none", () => {
    for (const id of [OLDER, KID, LONE, "20990101_000000_ffffff", null])
      expect(hermesPredecessor(id, [root])).toBeNull();
  });

  test("hermesCurrent names the caller's row, and is not confident about a cwd it never recorded", () => {
    expect(hermesCurrent(NEWER, "/somewhere/else", [root], NOW)).toMatchObject({
      sessionUuid: NEWER, projectDir: db, path: `${db}#${NEWER}`, cwd: "/somewhere/else",
      confident: false, source: "hermes", eventAgeSec: 900,
    });
    expect(hermesCurrent("20990101_000000_ffffff", "/x", [root], NOW)).toBeNull();
  });
});

/*
 * End to end through the CLI: sources.ts reads ~/.relic/sources.json from HOME, so each
 * run is a child process whose HOME is a temp dir. Nothing of this machine leaks in.
 */
describe("no-argument tail/recap, now and now --all, through the CLI", () => {
  const home = join(tmp, "home");
  const code = join(tmp, "code", "github.com", "acme");
  const widget = join(code, "widget");                 // Hermes is newest here
  const gadget = join(code, "gadget");                 // a Claude transcript is newest here
  const db = join(home, ".hermes", "profiles", "p", "state.db");
  const C1 = "c1c1c1c1-1111-4000-8000-000000000000";
  const C2 = "c2c2c2c2-2222-4000-8000-000000000000";
  // Two Discord sessions on one session_key: no cwd, so only their own line can find them.
  const [OLDER, NEWER] = ["20260923_080000_dddd01", "20260923_110000_dddd02"];
  const KEY = "agent:main:discord:thread:1550066820973858898:1550066820973858898";

  const claude = (repo: string, uuid: string, lastAgo: number) => {
    const dir = join(home, ".claude", "projects", encodeProjectDir(repo));
    mkdirSync(dir, { recursive: true });
    const rec = (role: string, text: string, ago: number) => JSON.stringify({
      type: role, sessionId: uuid, uuid: `${uuid}-${ago}`, cwd: repo,
      timestamp: new Date(NOW - ago * 1000).toISOString(),
      message: { role, content: role === "user" ? text : [{ type: "text", text }] },
    });
    const p = join(dir, `${uuid}.jsonl`);
    writeFileSync(p, [rec("user", "fix the relay", lastAgo + 60), rec("assistant", "looking", lastAgo + 50),
                      rec("user", "and ship it", lastAgo + 10), rec("assistant", "shipped", lastAgo)].join("\n") + "\n");
    const t = new Date(NOW - lastAgo * 1000);
    utimesSync(p, t, t);
  };

  beforeAll(() => {
    for (const d of [widget, gadget, join(gadget, "wt", "other"), join(tmp, "empty"), join(tmp, "off-home", ".hermes")])
      mkdirSync(d, { recursive: true });
    mkdirSync(join(home, ".relic"), { recursive: true });
    writeFileSync(join(home, ".relic", "sources.json"), JSON.stringify({ enable: ["hermes"] }));
    makeDb(db, [
      { id: "20260923_100000_aaaa01", root: widget, title: "widget work", msgs: talk(60, "widget") },
      { id: "20260923_100500_aaaa02", root: widget, parent: "20260923_100000_aaaa01", msgs: talk(30, "a spawn") },
      { id: "20260923_090000_bbbb01", root: gadget, msgs: talk(7200, "gadget") },
      { id: "20260923_101000_bbbb02", root: join(gadget, "wt", "other"), msgs: talk(10, "sibling") },
      // Outside the 600s window below, so `now --all` stays about the sessions above.
      { id: OLDER, key: KEY, title: "yesterday's thread", msgs: talk(3 * 3600, "the relay") },
      { id: NEWER, key: KEY, msgs: talk(900, "the follow-up") },
    ]);
    claude(widget, C1, 3 * 3600);
    claude(gadget, C2, 120);
  });

  const relic = (cwd: string, args: string[], extra: Record<string, string> = {}, HOME = home) => {
    const env: Record<string, string | undefined> = { ...process.env, HOME, RELIC_NATIVE: "0", ...extra };
    for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_COMPANION_SESSION_ID",
                     "HERMES_SESSION_ID"])
      if (!(k in extra)) delete env[k];
    const out = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args],
                              { cwd, env, stdout: "pipe", stderr: "pipe" });
    return { code: out.exitCode, stdout: out.stdout.toString(), stderr: out.stderr.toString() };
  };

  test("a Hermes session in this checkout is picked when it is the newest", () => {
    const r = relic(widget, ["tail", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).file).toBe(`${db}#20260923_100000_aaaa01`);
    expect(JSON.parse(r.stdout).turns.map((t: any) => t.text)).toContain("widget done");
    // A Hermes id opens with its date; 8 characters would name the day, not the session.
    expect(r.stderr).toContain("← 20260923_100000_aaaa01");
  });

  test("a newer Claude transcript still wins, and a sibling worktree's Hermes session never counts", () => {
    const r = relic(gadget, ["tail", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).file).toEndWith(`${C2}.jsonl`);
  });

  test("the calling Hermes session is skipped when HERMES_SESSION_ID names it", () => {
    const r = relic(widget, ["tail", "--json"], { HERMES_SESSION_ID: "20260923_100000_aaaa01" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).file).toEndWith(`${C1}.jsonl`);
  });

  test("a Discord caller with nothing here gets the session before it on its session_key", () => {
    const r = relic(join(tmp, "empty"), ["tail", "--json"], { HERMES_SESSION_ID: NEWER });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).file).toBe(`${db}#${OLDER}`);
    expect(JSON.parse(r.stdout).turns.map((t: any) => t.text)).toContain("the relay done");
    expect(r.stderr).toContain(`${OLDER}  (the session before this one on its Hermes session_key)`);
  });

  test("recap follows the same line, and a miss in the index names the hermes corpus", () => {
    const r = relic(join(tmp, "empty"), ["recap"], { HERMES_SESSION_ID: NEWER });
    expect(r.stderr).toContain(`${OLDER}  (the session before this one on its Hermes session_key)`);
    // Nothing is indexed under this HOME, so recap — which reads the index — cannot answer.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("relic index --corpus hermes");
  });

  test("the session_key line is a fallback: a session in this checkout still comes first", () => {
    const r = relic(widget, ["tail", "--json"], { HERMES_SESSION_ID: NEWER });
    expect(JSON.parse(r.stdout).file).toBe(`${db}#20260923_100000_aaaa01`);
  });

  test("now names the Hermes caller by HERMES_SESSION_ID", () => {
    const json = relic(join(tmp, "empty"), ["now", "--json"], { HERMES_SESSION_ID: NEWER });
    expect(JSON.parse(json.stdout).current).toMatchObject({ sessionUuid: NEWER, source: "hermes", confident: false });
    const pretty = relic(join(tmp, "empty"), ["now"], { HERMES_SESSION_ID: NEWER });
    expect(pretty.stdout).toContain(`${NEWER}  ·  last message 15m ago`);
    expect(pretty.stdout).toContain("(no cwd recorded — a gateway session)");
    // The DB is a file: probing a transcript tree beneath it must not read as unreadable (#99).
    expect(json.stderr + pretty.stderr).not.toContain("cannot read");
    expect(relic(join(tmp, "empty"), ["now", "--plain"], { HERMES_SESSION_ID: NEWER }).stdout.trim()).toBe(NEWER);
  });

  test("lineage with no id draws the Hermes caller's own line", () => {
    const r = relic(join(tmp, "empty"), ["lineage", "--plain"], { HERMES_SESSION_ID: NEWER });
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).map(l => l.split("\t").slice(0, 3))).toEqual([
      [OLDER, "-", "-"], [NEWER, OLDER, "session_key"],
    ]);
  });

  test("now --all lists an active Hermes session and drops one outside the window", () => {
    const r = relic(tmp, ["now", "--all", "--json", "--window", "600"]);
    expect(r.code).toBe(0);
    const rows: any[] = JSON.parse(r.stdout).sessions;
    const hermes = rows.filter(s => s.source === "hermes").map(s => s.sessionUuid).sort();
    expect(hermes).toEqual(["20260923_100000_aaaa01", "20260923_101000_bbbb02"]);
    expect(rows.find(s => s.sessionUuid === "20260923_100000_aaaa01")).toMatchObject({ agents: 1, cwd: widget, files: [] });
    expect(rows.map(s => s.sessionUuid)).toContain(C2);
  });

  test("tail <id> reads an unindexed Hermes session straight from state.db", () => {
    const r = relic(tmp, ["tail", "20260923_090000_bbbb01", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).file).toBe(`${db}#20260923_090000_bbbb01`);
  });

  test("with the Hermes source off, a miss names the root it did not read", () => {
    const off = join(tmp, "off-home");
    const tail = relic(join(tmp, "empty"), ["tail"], {}, off);
    expect(tail.code).toBe(1);
    expect(tail.stderr).toContain("no earlier session found");
    expect(tail.stderr).toContain(`(${join(off, ".hermes")} holds Hermes data, but its source is disabled`);
    const now = relic(join(tmp, "empty"), ["now", "--all"], {}, off);
    expect(now.stdout).toContain("nothing written in the last 5m");
    expect(now.stdout).toContain(`(${join(off, ".hermes")} holds Hermes data, but its source is disabled`);
  });
});
