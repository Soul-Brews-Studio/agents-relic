import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkClaudeHome } from "../src/discover.js";
import { parseClaude } from "../src/shapes/claude.js";
import type { Found } from "../src/discover.js";
import { envHomes } from "../src/sources.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-homes-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * A HOME is one path, and that is what a bank should be.
 *
 * Claude Code v2.1.278, decompiled:
 *   function s(){ return process.env.CLAUDE_CONFIG_DIR }
 *   (s() ?? join(homedir(), ".claude")).normalize("NFC")
 *
 * One path, not a list. Codex does the same with CODEX_HOME.
 */
describe("the claude-home walk covers every projects* root in one home", () => {
  const home = join(tmp, "home");
  for (const [root, proj] of [["projects", "-a"], ["projects-archive", "-b"],
                              ["projects-1sep-tue2026", "-c"]] as const) {
    const d = join(home, root, proj);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "s.jsonl"),
      JSON.stringify({ type: "user", uuid: "u", sessionId: "s", cwd: "/tmp",
                       message: { role: "user", content: "hi there" } }) + "\n");
  }
  // Not a projects root — must NOT be walked, or a home's caches become transcripts.
  mkdirSync(join(home, "plugins", "-d"), { recursive: true });
  writeFileSync(join(home, "plugins", "-d", "s.jsonl"), "{}\n");

  /*
   * The walker DIRECTLY, not through discover().
   *
   * Going through discover() would need `claude-neo` declared in ~/.relic/sources.json,
   * which makes the test assert about this machine's config instead of the code — the
   * same mistake the --source-path test shipped with and had to be fixed.
   */
  const walk = (): Found[] => {
    const out: Found[] = [];
    walkClaudeHome(home, null, out, "claude-neo", parseClaude);
    for (const f of out) f.bank = "claude-neo";     // discover() stamps this per source
    return out;
  };

  test("all three roots, and nothing outside them", () => {
    const found = walk();
    const roots = [...new Set(found.map(f => f.path.slice(home.length + 1).split("/")[0]))].sort();
    expect(roots).toEqual(["projects", "projects-1sep-tue2026", "projects-archive"]);
  });

  test("ONE bank for the whole home — that is the entire point", () => {
    // Three roots inside ~/.claude currently get three banks. A home is one identity,
    // so its roots belong in one bank; uid already collapses the overlap at read time.
    const found = walk();
    expect([...new Set(found.map(f => f.bank))]).toEqual(["claude-neo"]);
  });

  test("the live root is walked FIRST, so a killed run keeps the useful half", () => {
    const found = walk();
    expect(found[0].path.startsWith(join(home, "projects/"))).toBe(true);
  });
});

describe("envHomes reports, and never acts", () => {
  test("silent when nothing is set", () => {
    const prev = process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CLAUDE_CONFIG_DIR;
    expect(envHomes().some(e => e.env === "CLAUDE_CONFIG_DIR")).toBe(false);
    if (prev !== undefined) process.env.CLAUDE_CONFIG_DIR = prev;
  });

  test("a non-default home is flagged, not followed", () => {
    /*
     * Following it silently is the failure: relic would index the DEFAULT home, find
     * plenty, and print a clean summary for the wrong agent's history. Worse on a
     * shared machine — another account's transcripts in a bank named for this one.
     */
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = "/somewhere/else/.claude";
    const e = envHomes().find(x => x.env === "CLAUDE_CONFIG_DIR")!;
    expect(e.path).toBe("/somewhere/else/.claude");
    expect(e.isDefault).toBe(false);
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  });

  test("parserFor picks parseClaude for .jsonl transcripts even when a nested memory source exists", () => {
    const { parserFor, loadSources } = require("../src/sources.js");
    const { parseClaude } = require("../src/shapes/claude.js");
    const { parseMemory } = require("../src/shapes/memory.js");
    const sources = loadSources();
    const memSource = sources.find((s: any) => s.walk === "memory");
    if (memSource) {
      expect(parserFor(`${memSource.path}/-proj/s.jsonl`)).toBe(parseClaude);
      expect(parserFor(`${memSource.path}/-proj/memory/fact.md`)).toBe(parseMemory);
    }
  });
});
