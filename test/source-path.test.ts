import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discover } from "../src/discover.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-srcpath-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/**
 * `--source-path` was documented in sources.ts before it existed — the comment told
 * you to run a command that fails. These pin the behaviour so it stays true.
 */
describe("discover(pathOverride)", () => {
  const vault = join(tmp, "wt", "some-worktree", "ψ", "memory", "learnings");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "a-note.md"), "---\nname: a\n---\n\nsome learning text here\n");
  writeFileSync(join(vault, "b-note.md"), "---\nname: b\n---\n\nanother learning text\n");

  test("runs one source against a root it does not normally walk", () => {
    const found = discover(["oracle-vault"], null,
                           { key: "oracle-vault", path: join(tmp, "wt", "some-worktree", "ψ") });
    expect(found.map(f => f.path.split("/").pop()).sort()).toEqual(["a-note.md", "b-note.md"]);
  });

  test("the walker, parser and BANK are unchanged — only the root moves", () => {
    // This is what makes the rows land where the rest of that source's rows live.
    // An override that also changed the bank would scatter one source across two.
    const [f] = discover(["oracle-vault"], null,
                         { key: "oracle-vault", path: join(tmp, "wt", "some-worktree", "ψ") });
    expect(f.source).toBe("oracle-vault");
    expect(f.bank).toBe("vault");
  });

  test("an override whose key does not match redirects NOTHING", () => {
    /*
     * The key must match, or this silently redirects the wrong source.
     *
     * Asserted as "no result came from the override root", not as an empty list:
     * oracle-vault's real path is per-machine (~/.relic/sources.json points it at a
     * real vault here, at a placeholder elsewhere), and the first version of this
     * test asserted [] and failed against 10,129 real files. An environment-dependent
     * assertion tests the machine, not the code.
     */
    const root = join(tmp, "wt", "some-worktree", "ψ");
    const found = discover(["oracle-vault"], null, { key: "codex", path: root });
    expect(found.filter(f => f.path.startsWith(root))).toEqual([]);
  });

  test("no override leaves discovery exactly as it was", () => {
    expect(discover(["oracle-vault"], null)).toEqual(discover(["oracle-vault"], null, null));
  });
});
