import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptRoots, homeProjectRoots, parserFor, type SourceDef } from "../src/sources.js";
import { parseClaude } from "../src/shapes/claude.js";
import { parseMemory } from "../src/shapes/memory.js";
import { parseVault } from "../src/shapes/vault.js";

// #65: a declared home is the one transcript source whose path is not a projects root.
// #69: memory and transcript sources share roots, so a path prefix alone picked the wrong parser.

const tmp = mkdtempSync(join(tmpdir(), "relic-declared-homes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const src = (o: Partial<SourceDef> & Pick<SourceDef, "key" | "path" | "walk" | "parser">): SourceDef =>
  ({ enabled: true, note: "", ...o });

describe("transcriptRoots", () => {
  const home = join(tmp, "roots-home");
  for (const d of ["projects", "projects-archive", "projects-1sep-tue2026", "plugins"])
    mkdirSync(join(home, d), { recursive: true });

  test("a declared home expands to its projects* roots, live root first", () => {
    const roots = transcriptRoots(src({ key: "claude-x", path: home, walk: "claude-home", parser: parseClaude }));
    expect(roots).toEqual([join(home, "projects"), join(home, "projects-1sep-tue2026"), join(home, "projects-archive")]);
    expect(homeProjectRoots(home)).toEqual(roots);
  });

  test("tiers and omp are their own root; memory and flat are not transcript roots", () => {
    expect(transcriptRoots(src({ key: "a", path: "/p", walk: "claude-tiers", parser: parseClaude }))).toEqual(["/p"]);
    expect(transcriptRoots(src({ key: "b", path: "/o", walk: "omp", parser: parseClaude }))).toEqual(["/o"]);
    expect(transcriptRoots(src({ key: "c", path: "/p", walk: "memory", parser: parseMemory }))).toEqual([]);
    expect(transcriptRoots(src({ key: "d", path: "/c", walk: "flat", parser: parseClaude }))).toEqual([]);
  });

  test("a missing home has no roots rather than throwing", () => {
    expect(homeProjectRoots(join(tmp, "nope"))).toEqual([]);
  });
});

describe("parserFor", () => {
  const home = "/h/.claude-neo";
  const declared = [
    src({ key: "claude-neo", path: home, walk: "claude-home", parser: parseClaude }),
    src({ key: "claude-neo-memory", path: `${home}/projects`, walk: "memory", parser: parseMemory }),
  ];
  const builtin = [
    src({ key: "claude-live", path: "/h/.claude/projects", walk: "claude-tiers", parser: parseClaude }),
    src({ key: "claude-memory", path: "/h/.claude/projects", walk: "memory", parser: parseMemory }),
  ];

  test("a declared home's transcript gets the transcript parser, not the memory one", () => {
    expect(parserFor(`${home}/projects/-work-repo/aaaa.jsonl`, declared)).toBe(parseClaude);
    expect(parserFor(`${home}/projects/-work-repo/aaaa/subagents/agent-a1.jsonl`, declared)).toBe(parseClaude);
  });

  test("a declared home's memory file still gets the memory parser", () => {
    expect(parserFor(`${home}/projects/-work-repo/memory/feedback_x.md`, declared)).toBe(parseMemory);
  });

  test("the built-in mirror: a memory file under a shared root is memory, a transcript is not", () => {
    expect(parserFor("/h/.claude/projects/-work-repo/memory/feedback_x.md", builtin)).toBe(parseMemory);
    expect(parserFor("/h/.claude/projects/-work-repo/bbbb.jsonl", builtin)).toBe(parseClaude);
  });

  test("a root is a directory, not a string prefix", () => {
    const vault = [src({ key: "v", path: "/r/projects", walk: "vault", parser: parseVault })];
    expect(parserFor("/r/projects-archive/-x/s.jsonl", vault)).toBe(parseClaude);
    expect(parserFor("/r/projects/note.md", vault)).toBe(parseVault);
  });

  test("a trailing slash in a configured path still matches", () => {
    const vault = [src({ key: "v", path: "/r/vault/", walk: "vault", parser: parseVault })];
    expect(parserFor("/r/vault/note.md", vault)).toBe(parseVault);
  });

  test("an unclaimed memory-shaped file falls back to the memory parser", () => {
    expect(parserFor(`${home}/projects-archive/-old/memory/x.md`, declared)).toBe(parseMemory);
  });
});

/*
 * End to end through the real config: sources.ts reads ~/.relic/sources.json from HOME at
 * import, so this runs in a child process whose HOME is a temp dir. No machine config leaks in.
 */
describe("a declared home through loadSources", () => {
  const home = join(tmp, "e2e");
  const claudeHome = join(home, ".claude-test");
  const A = "aaaaaaaa-1111-4000-8000-000000000000";
  const B = "bbbbbbbb-2222-4000-8000-000000000000";
  const line = (id: string, type: string, text: string, ts: string) => JSON.stringify({
    type, sessionId: id, uuid: `${id}-${ts}`, timestamp: `2026-09-23T${ts}.000Z`, cwd: "/work/repo",
    message: { role: type, content: text },
  });

  mkdirSync(join(home, ".relic"), { recursive: true });
  writeFileSync(join(home, ".relic", "sources.json"),
    JSON.stringify({ homes: [{ key: "claude-test", path: "~/.claude-test" }] }));
  const proj = join(claudeHome, "projects", "-work-repo");
  mkdirSync(join(proj, A, "subagents"), { recursive: true });
  mkdirSync(join(proj, "memory"), { recursive: true });
  writeFileSync(join(proj, `${A}.jsonl`),
    [line(A, "user", "hello there", "01:00:00"), line(A, "assistant", "hi", "01:00:05")].join("\n") + "\n");
  writeFileSync(join(proj, A, "subagents", "agent-a0123456789abcdef.jsonl"), line(A, "user", "sub", "01:00:02") + "\n");
  writeFileSync(join(proj, "memory", "feedback_x.md"), "---\nname: x\ndescription: d\n---\nbody\n");
  const old = join(claudeHome, "projects-archive", "-work-old");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, `${B}.jsonl`), line(B, "user", "archived", "02:00:00") + "\n");

  const probe = () => {
    const src = join(import.meta.dir, "..", "src");
    const script = `
      const { liveRoots } = await import("${src}/live.ts");
      const { seekOnDisk } = await import("${src}/seek.ts");
      const { findSessions, isClaudeProjectDir } = await import("${src}/lineage.ts");
      const { parserFor } = await import("${src}/sources.ts");
      console.log(JSON.stringify({
        roots: liveRoots(),
        seek: seekOnDisk("aaaaaaaa").map(f => [f.tier, f.bank]).sort(),
        byCwd: findSessions("aaaaaaaa", "/work/repo").map(h => h.id),
        bySweep: findSessions("bbbbbbbb", "/nowhere").map(h => h.id),
        projectDir: isClaudeProjectDir("${proj}"),
        transcript: parserFor("${join(proj, `${A}.jsonl`)}").name,
        memory: parserFor("${join(proj, "memory", "feedback_x.md")}").name,
      }));`;
    const env = { ...process.env, HOME: home };
    delete env.CLAUDE_CONFIG_DIR;
    const out = Bun.spawnSync(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    if (out.exitCode !== 0) throw new Error(out.stderr.toString());
    return JSON.parse(out.stdout.toString().trim().split("\n").pop()!);
  };

  test("live roots, on-demand seek, lineage and the parser all see the declared home", () => {
    const r = probe();
    expect(r.roots).toContain(join(claudeHome, "projects"));
    expect(r.roots).toContain(join(claudeHome, "projects-archive"));
    expect(r.roots).not.toContain(claudeHome);
    expect(r.seek).toEqual([["session", "claude-test"], ["subagent", "claude-test"]]);
    expect(r.byCwd).toEqual([A]);
    expect(r.bySweep).toEqual([B]);
    expect(r.projectDir).toBe(true);
    expect(r.transcript).toBe("parseClaude");
    expect(r.memory).toBe("parseMemory");
  });
});
