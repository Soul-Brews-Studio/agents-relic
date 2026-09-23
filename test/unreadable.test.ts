import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkClaudeHome, type Found } from "../src/discover.js";
import { homeProjectRoots } from "../src/sources.js";
import { parseClaude } from "../src/shapes/claude.js";
import { beginWalk, walkFailures, reachable } from "../src/unreadable.js";
import { pruneRefusal } from "../src/prune.js";
import { logSkipped, logSkippedFiles, readSkipped, readSkippedFiles } from "../src/noise.js";
import type { ImportTally } from "../src/import.js";

/**
 * #99: every walker answered a failed readdir or stat with an empty list, so an
 * unreadable directory looked exactly like an empty one — `relic pending` said
 * "0 missing" about files it had never been able to see.
 *
 * chmod 000 is the whole fixture, and root ignores it, so these skip under root.
 */

const tmp = mkdtempSync(join(tmpdir(), "relic-unreadable-"));
const locked: string[] = [];
const lock = (p: string) => { chmodSync(p, 0o000); locked.push(p); };
afterAll(() => {
  for (const p of locked) chmodSync(p, 0o755);       // or rmSync cannot descend
  rmSync(tmp, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0;
const A = "aaaaaaaa-1111-4000-8000-000000000000";
const B = "bbbbbbbb-2222-4000-8000-000000000000";
const line = (id: string) => JSON.stringify({ type: "user", sessionId: id, uuid: `${id}-1`,
  timestamp: "2026-09-23T01:00:00.000Z", cwd: "/work/repo", message: { role: "user", content: "hi" } }) + "\n";

/** A fresh `<home>/projects` per test — stderr is once per path per process, so paths must not repeat. */
function home(name: string): { home: string; projects: string } {
  const h = join(tmp, name);
  mkdirSync(join(h, "projects"), { recursive: true });
  return { home: h, projects: join(h, "projects") };
}

function put(path: string, body = line(A)) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** The `relic: cannot read` lines a call writes to stderr, and nothing else it writes there. */
function warnings(fn: () => void): string[] {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  try { fn(); return spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("relic:")); }
  finally { spy.mockRestore(); }
}

function walk(h: string): { found: string[]; said: string[] } {
  const out: Found[] = [];
  beginWalk();
  const said = warnings(() => walkClaudeHome(h, null, out, "k", parseClaude));
  return { found: out.map(f => f.path).sort(), said };
}

describe.skipIf(asRoot)("an unreadable directory", () => {
  test("a project dir: exactly one warning, still empty, the rest still found", () => {
    const { home: h, projects } = home("project");
    put(join(projects, "-work-ok", `${A}.jsonl`));
    const bad = join(projects, "-work-locked");
    put(join(bad, `${B}.jsonl`), line(B));
    put(join(bad, B, "subagents", "agent-a1.jsonl"), line(B));
    lock(bad);

    const { found, said } = walk(h);
    expect(found).toEqual([join(projects, "-work-ok", `${A}.jsonl`)]);
    // files(), the subagents probe and dirs() all hit it — one line, not three.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(bad);
    expect(said[0]).toContain("EACCES");
    expect(walkFailures().map(x => [x.rule, x.path])).toEqual([["dir-unreadable", bad]]);
  });

  test("a session dir without search permission no longer reads as 'no subagents'", () => {
    // existsSync(<uuid>/subagents) answers false for EACCES exactly as for ENOENT.
    const { home: h, projects } = home("session");
    const proj = join(projects, "-work-sess");
    put(join(proj, `${A}.jsonl`));
    put(join(proj, A, "subagents", "agent-a1.jsonl"));
    lock(join(proj, A));

    const { found, said } = walk(h);
    expect(found).toEqual([join(proj, `${A}.jsonl`)]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(join(proj, A, "subagents"));
  });

  test("a second walk in one process stays quiet on stderr but still counts it", () => {
    // What a long-lived MCP server does: `relic_pending` twice must report it twice.
    const { home: h, projects } = home("twice");
    const bad = join(projects, "-work-locked");
    mkdirSync(bad);
    lock(bad);

    expect(walk(h).said).toHaveLength(1);
    const again = walk(h);
    expect(again.said).toEqual([]);
    expect(walkFailures().map(x => x.path)).toEqual([bad]);
  });

  test("a declared home that cannot be read says so instead of contributing nothing", () => {
    const h = join(tmp, "declared-home");
    mkdirSync(join(h, "projects"), { recursive: true });
    lock(h);
    let roots: string[] = [];
    const said = warnings(() => { roots = homeProjectRoots(h); });
    expect(roots).toEqual([]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(h);
  });

  test("a file where a directory belongs is a failure too (ENOTDIR), not an absence", () => {
    const { home: h, projects } = home("notdir");
    const proj = join(projects, "-work-odd");
    put(join(proj, `${A}.jsonl`));
    put(join(proj, A, "subagents"), "not a directory\n");
    const { said } = walk(h);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("ENOTDIR");
  });
});

describe("a missing directory", () => {
  test("stays quiet — optional subdirs are the normal case in these walkers", () => {
    // Sessions with no subagents/, subagents with no workflows/: every probe is ENOENT.
    const { home: h, projects } = home("quiet");
    put(join(projects, "-work-a", `${A}.jsonl`));
    put(join(projects, "-work-b", `${B}.jsonl`), line(B));
    put(join(projects, "-work-b", B, "subagents", "agent-b1.jsonl"), line(B));
    mkdirSync(join(projects, "-work-c", A), { recursive: true });

    const { found, said } = walk(h);
    expect(found).toHaveLength(3);
    expect(said).toEqual([]);
    expect(walkFailures()).toEqual([]);
  });

  test("a missing home or root is absence, not an error", () => {
    beginWalk();
    const said = warnings(() => {
      expect(homeProjectRoots(join(tmp, "no-such-home"))).toEqual([]);
      expect(reachable(join(tmp, "no-such-root"))).toBe(false);
    });
    expect(said).toEqual([]);
    expect(walkFailures()).toEqual([]);
  });
});

describe("prune after a walk that could not read everything", () => {
  const tally = { failed: 0 } as ImportTally;

  test("is refused — an unreadable directory is not a deleted one", () => {
    const why = pruneRefusal(tally, { sinceMs: null, repoFilter: null, unreadable: 2 });
    expect(why).toContain("2 paths could not be read");
  });

  test("goes ahead when the walk read everything", () => {
    expect(pruneRefusal(tally, { sinceMs: null, repoFilter: null, unreadable: 0 })).toBeNull();
    expect(pruneRefusal(tally, { sinceMs: null, repoFilter: null })).toBeNull();
  });
});

describe("the proof log carries unreadable paths beside dropped events", () => {
  const dataRoot = join(tmp, "proof");
  logSkipped([{ uid: "u1", file_path: "/x/a.jsonl", seq: 3, role: "tool_result",
                rule: "binary-blob", bytes: 500, head: "AAAA" }], dataRoot);
  const row = (path: string, ts: string, rule: "dir-unreadable" | "walk-error" = "dir-unreadable") =>
    ({ rule, path, error: "EACCES: permission denied", ts });
  // The same directory, logged by two index runs; and one file.
  logSkippedFiles([row("/r/-locked", "2026-09-22T01:00:00.000Z"), row("/r/-x/s.jsonl", "2026-09-22T01:00:00.000Z", "walk-error")], dataRoot);
  logSkippedFiles([row("/r/-locked", "2026-09-23T01:00:00.000Z")], dataRoot);

  test("event counts are not inflated by path rows", () => {
    const st = readSkipped(dataRoot)!;
    expect(st.total).toBe(1);
    expect(st.byRule.map(r => r.rule)).toEqual(["binary-blob"]);
  });

  test("one row per path, newest record, with the number of runs that logged it", () => {
    const fs = readSkippedFiles(dataRoot)!;
    expect(fs.total).toBe(2);
    expect(fs.byRule).toEqual([{ rule: "dir-unreadable", n: 1 }, { rule: "walk-error", n: 1 }]);
    const lockedRow = fs.paths.find(p => p.path === "/r/-locked")!;
    expect(lockedRow.runs).toBe(2);
    expect(lockedRow.ts).toBe("2026-09-23T01:00:00.000Z");
    expect(fs.paths[0].path).toBe("/r/-locked");            // newest first
  });
});

/*
 * End to end through the real config: sources.ts reads ~/.relic/sources.json from HOME at
 * import, so these run in a child whose HOME is a temp dir. No machine config leaks in.
 */
const SRC = join(import.meta.dir, "..", "src");

function child(h: string, script: string): { out: string; err: string; code: number } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: h };
  for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_COMPANION_SESSION_ID"])
    delete env[k];
  const r = Bun.spawnSync(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

function cli(h: string, ...args: string[]): { out: string; err: string; code: number } {
  const env: Record<string, string | undefined> = { ...process.env, HOME: h };
  for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_COMPANION_SESSION_ID"])
    delete env[k];
  const r = Bun.spawnSync(["bun", join(SRC, "cli.ts"), ...args], { env, stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

const cannotRead = (err: string) => err.split("\n").filter(l => l.startsWith("relic: cannot read"));

describe("a broken ~/.relic/sources.json", () => {
  const probe = (name: string, body: string) => {
    const h = join(tmp, name);
    mkdirSync(join(h, ".relic"), { recursive: true });
    writeFileSync(join(h, ".relic", "sources.json"), body);
    return child(h, `
      const { loadSources } = await import("${SRC}/sources.ts");
      loadSources(); loadSources();
      const srcs = loadSources();
      console.log(JSON.stringify({ keys: srcs.map(s => s.key), hermes: srcs.find(s => s.key === "hermes")?.enabled }));`);
  };
  const last = (out: string) => JSON.parse(out.trim().split("\n").pop()!);

  test("prints the parse error once, naming the file, and falls back to the builtins", () => {
    const r = probe("cfg-syntax", `{ "enable": ["hermes"], }`);
    expect(r.code).toBe(0);
    const said = r.err.split("\n").filter(l => l.includes("sources.json"));
    expect(said).toHaveLength(1);                              // three loads, one line
    expect(said[0]).toContain(join(tmp, "cfg-syntax", ".relic", "sources.json"));
    expect(said[0]).toContain("built-in sources only");
    expect(last(r.out).keys).toContain("claude-live");
    expect(last(r.out).hermes).toBe(false);                   // nothing from the file applied
  });

  test("names the section of a bad entry, and keeps what was applied before it", () => {
    const r = probe("cfg-entry", JSON.stringify({ enable: ["hermes"], homes: [null] }));
    expect(r.code).toBe(0);
    expect(r.err).toContain(`bad "homes" entry`);
    expect(r.err).toContain("partly applied");
    expect(last(r.out).hermes).toBe(true);                    // `enable` ran before `homes` threw
  });
});

describe.skipIf(asRoot)("through the commands", () => {
  const h = join(tmp, "e2e");
  const projects = join(h, ".claude", "projects");
  const data = join(h, "data");
  put(join(projects, "-work-ok", `${A}.jsonl`));
  const bad = join(projects, "-work-locked");
  put(join(bad, `${B}.jsonl`), line(B));
  lock(bad);

  test("discover, seek and live in one process: one line for one directory", () => {
    const r = child(h, `
      const { discover } = await import("${SRC}/discover.ts");
      const { seekOnDisk } = await import("${SRC}/seek.ts");
      const { liveSessions } = await import("${SRC}/live.ts");
      const { walkFailures } = await import("${SRC}/unreadable.ts");
      const found = discover(null, null).length;
      const failures = walkFailures().map(x => x.path);
      const seek = seekOnDisk("aaaaaaaa").length;
      await liveSessions(3600);
      console.log(JSON.stringify({ found, failures, seek }));`);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split("\n").pop()!)).toEqual({ found: 1, failures: [bad], seek: 1 });
    expect(cannotRead(r.err)).toHaveLength(1);
  });

  test("pending says the count covers only what the walk could read", () => {
    const r = cli(h, "pending", "--data-root", data, "--json");
    expect(r.code).toBe(0);
    const rep = JSON.parse(r.out);
    expect(rep.found).toBe(1);
    expect(rep.unreadable.map((x: { path: string }) => x.path)).toEqual([bad]);
  });

  test("index logs it, skipped --files lists it, and prune refuses to run", () => {
    const idx = cli(h, "index", "--data-root", data, "--prune");
    expect(idx.code).toBe(0);
    expect(cannotRead(idx.err)).toHaveLength(1);
    expect(idx.out).toContain("unreadable: 1 path could not be read");
    expect(idx.out).toContain("prune REFUSED");

    const files = cli(h, "skipped", "--files", "--data-root", data, "--json");
    expect(files.code).toBe(0);
    expect(JSON.parse(files.out).paths.map((x: { path: string }) => x.path)).toEqual([bad]);

    const pretty = cli(h, "skipped", "--files", "--data-root", data);
    expect(pretty.out).toContain("[dir-unreadable]");
    expect(pretty.out).toContain(bad);
  });
});
