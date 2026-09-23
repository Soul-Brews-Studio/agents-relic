import { expect, test, describe, afterAll, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dig } from "../src/dig.js";
import { listShards } from "../src/repo.js";
import { encodeProjectDir } from "../src/live.js";

/**
 * Follow-up to #99: the lookups #113 did not reach — lineage, the tail/recap
 * "previous session" lookup, dig, the shard listing and the repo index. Each answered a
 * failed readdir with an empty list, so an unreadable directory read as "no session
 * matches" or "no earlier session found" while the session sat right there.
 *
 * chmod 000 is the fixture, and root ignores it, so those tests skip under root.
 */

const tmp = realpathSync(mkdtempSync(join(tmpdir(), "relic-lookups-")));   // cwd-encoding needs the real path
const locked: string[] = [];
const lock = (p: string) => { chmodSync(p, 0o000); locked.push(p); };
afterAll(() => {
  for (const p of locked) chmodSync(p, 0o755);       // or rmSync cannot descend
  rmSync(tmp, { recursive: true, force: true });
});

const asRoot = process.getuid?.() === 0;
const A = "aaaaaaaa-1111-4000-8000-000000000000";
const line = (id: string, cwd = "/work/repo") => JSON.stringify({ type: "user", sessionId: id, uuid: `${id}-1`,
  timestamp: "2026-09-23T01:00:00.000Z", cwd, message: { role: "user", content: "what was I doing" } }) + "\n";

function put(path: string, body = line(A)) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

const SRC = join(import.meta.dir, "..", "src");
const cannotRead = (err: string) => err.split("\n").filter(l => l.startsWith("relic: cannot read"));

/** A child whose HOME is `home`: sources.ts reads ~/.relic/sources.json at import. */
function run(home: string, argv: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, ...opts.env };
  for (const k of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID", "CODEX_COMPANION_SESSION_ID"])
    delete env[k];
  const r = Bun.spawnSync(["bun", ...argv], { env, cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString(), err: r.stderr.toString(), code: r.exitCode ?? -1 };
}

/** The `relic:` lines an async call writes to stderr. */
async function warnings(fn: () => Promise<unknown>): Promise<string[]> {
  const spy = spyOn(process.stderr, "write").mockImplementation(() => true);
  try { await fn(); return spy.mock.calls.map(c => String(c[0])).filter(l => l.startsWith("relic:")); }
  finally { spy.mockRestore(); }
}

describe.skipIf(asRoot)("lineage", () => {
  test("a session in an unreadable project dir is reported, not 'no session matches'", () => {
    const home = join(tmp, "lineage");
    const cwd = join(tmp, "lineage-work", "repo");
    mkdirSync(cwd, { recursive: true });
    const proj = join(home, ".claude", "projects", encodeProjectDir(cwd));
    put(join(proj, `${A}.jsonl`), line(A, cwd));
    put(join(home, ".claude", "projects", "-work-other", "cccccccc-3333-4000-8000-000000000000.jsonl"));
    lock(proj);

    // The walk-up probes this cwd's project dir first, then the sweep lists every project
    // dir — both reach the locked one, and it is still one line.
    const r = run(home, ["-e", `
      const { findSessions } = await import("${SRC}/lineage.ts");
      console.log(JSON.stringify(findSessions("aaaaaaaa", "${cwd}")));`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split("\n").pop()!)).toEqual([]);
    const said = cannotRead(r.err);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(proj);
    expect(said[0]).toContain("EACCES");
  });

  test("a cwd whose encoded name cannot exist is absence, not an error (ENAMETOOLONG)", () => {
    const home = join(tmp, "lineage-long");
    put(join(home, ".claude", "projects", "-work-repo", `${A}.jsonl`));
    const deep = "/" + "x".repeat(300);                 // past APFS's 255 characters and ext4's 255 bytes
    const r = run(home, ["-e", `
      const { findSessions } = await import("${SRC}/lineage.ts");
      console.log(JSON.stringify(findSessions("aaaaaaaa", "${deep}").map(h => h.id)));`]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split("\n").pop()!)).toEqual([A]);   // found by the sweep
    expect(r.err).not.toContain("relic:");
  });
});

describe.skipIf(asRoot)("the tail/recap previous-session lookup", () => {
  const tail = (home: string, cwd: string) => run(home, [join(SRC, "cli.ts"), "tail"], { cwd });

  test("an unreadable project dir says so instead of 'no earlier session found' alone", () => {
    const home = join(tmp, "tail");
    const cwd = join(tmp, "tail-work", "repo");
    mkdirSync(cwd, { recursive: true });
    const proj = join(home, ".claude", "projects", encodeProjectDir(cwd));
    put(join(proj, `${A}.jsonl`), line(A, cwd));
    lock(proj);

    const r = tail(home, cwd);
    expect(r.code).toBe(1);
    expect(r.err).toContain("no earlier session found");
    const said = cannotRead(r.err);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(proj);
  });

  test("a directory with no project at all stays quiet", () => {
    const home = join(tmp, "tail-none");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const cwd = join(tmp, "tail-none-work");
    mkdirSync(cwd, { recursive: true });
    const r = tail(home, cwd);
    expect(r.err).toContain("no earlier session found");
    expect(r.err).not.toContain("relic:");
  });

  test("a cwd too deep to encode stays quiet", () => {
    const home = join(tmp, "tail-long");
    mkdirSync(join(home, ".claude", "projects"), { recursive: true });
    const cwd = join(tmp, "y".repeat(200), "z".repeat(100));          // each part fits, the encoding does not
    mkdirSync(cwd, { recursive: true });
    const r = tail(home, cwd);
    expect(r.err).toContain("no earlier session found");
    expect(r.err).not.toContain("relic:");
  });
});

describe.skipIf(asRoot)("dig", () => {
  test("an unreadable project dir and an unreadable session dir are each one line", async () => {
    const bad = join(tmp, "dig", "-work-locked");
    put(join(bad, `${A}.jsonl`));
    lock(bad);
    const ok = join(tmp, "dig", "-work-ok");
    put(join(ok, `${A}.jsonl`));
    put(join(ok, A, "subagents", "agent-a1.jsonl"));
    lock(join(ok, A));

    let rows: unknown[] = [];
    // Only this fixture's lines: resolving a repo name can read the machine's ghq tree.
    const said = (await warnings(async () => { rows = await dig({ projectDirs: [bad, ok], deep: true, noCache: true }); }))
      .filter(l => l.includes(tmp));
    expect(said).toHaveLength(2);
    expect(said[0]).toContain(bad);
    expect(said[1]).toContain(join(ok, A, "subagents"));
    expect(rows.filter(r => (r as { sessionId?: string }).sessionId)).toHaveLength(1);   // the readable session
  });
});

describe.skipIf(asRoot)("listShards", () => {
  test("an unreadable bank is reported, and the readable ones still list", async () => {
    const data = join(tmp, "shards");
    mkdirSync(join(data, "banks", "projects", "github.com", "o", "r"), { recursive: true });
    const bad = join(data, "banks", "locked-bank");
    mkdirSync(join(bad, "github.com", "o", "r"), { recursive: true });
    lock(bad);

    let keys: string[] = [];
    const said = await warnings(async () => { keys = listShards(data).map(s => s.key); });
    expect(keys).toEqual(["projects/github.com/o/r"]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(bad);
  });
});

describe.skipIf(asRoot || !Bun.which("ghq"))("the repo index", () => {
  test("one unreadable org is reported and no longer ends the walk", () => {
    // `ghq root` honours GHQ_ROOT, so the child indexes this tree and not the machine's.
    const ghq = join(tmp, "ghq");
    for (const org of ["a-org", "m-org", "z-org"]) mkdirSync(join(ghq, "github.com", org, `${org}-repo`), { recursive: true });
    lock(join(ghq, "github.com", "m-org"));
    mkdirSync(join(tmp, "ghq-home"));
    const r = run(join(tmp, "ghq-home"), ["-e", `
      const { repoIndex } = await import("${SRC}/repo.ts");
      console.log(JSON.stringify([...repoIndex().keys()].sort()));`], { env: { GHQ_ROOT: ghq } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out.trim().split("\n").pop()!)).toEqual(["a-org-repo", "z-org-repo"]);
    const said = cannotRead(r.err);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(join(ghq, "github.com", "m-org"));
  });
});
