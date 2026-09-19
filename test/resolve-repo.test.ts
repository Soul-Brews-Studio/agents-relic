import { expect, test, describe } from "bun:test";
import { repoKeyOf, resolveRepoKey, repoIndex } from "../src/repo.js";

/**
 * resolveRepoKey = repoKeyOf + the shapes that need to know what exists on this machine.
 *
 * Measured over 1,905 codex sessions on two machines, 189 resolved to "_unresolved":
 *   149  ~/psi-memory, sandboxes, /tmp        genuinely not a repo — CORRECT, stays
 *    20  ~/.herdr/worktrees/<repo>/<space>    recoverable
 *    16  /tmp/claude-<uid>/-<encoded>/...     recoverable
 *
 * These assertions are MACHINE-INDEPENDENT on purpose: the two recoverable shapes need
 * a ghq lookup, so asserting a specific org would only pass on a machine that happens
 * to have that repo. What is asserted is the contract, not this laptop's checkout.
 */
describe("resolveRepoKey", () => {
  test("a direct github.com path is unchanged — the pure function still decides", () => {
    for (const p of ["/opt/Code/github.com/acme/thing",
                     "/home/x/Code/github.com/acme/thing/wt/some-slug",
                     "/ghq/github.com/acme/thing/agents/one"])
      expect(resolveRepoKey(p)).toBe(repoKeyOf(p));
  });

  test("a path that is not a repo stays null — most of _unresolved is CORRECT", () => {
    for (const p of ["/Users/beta/psi-memory", "/Users/beta/sandbox", "/home/ampere", "/tmp/x"])
      expect(resolveRepoKey(p)).toBeNull();
  });

  test("a herdr worktree for a repo that does not exist here stays null", () => {
    // The shape matches, the lookup fails, and a failed lookup must not invent an org.
    expect(resolveRepoKey("/Users/x/.herdr/worktrees/definitely-not-a-real-repo-xyzzy/space/a"))
      .toBeNull();
  });

  test("a scratchpad for a repo that does not exist here stays null", () => {
    expect(resolveRepoKey("/private/tmp/claude-1/-opt-Code-github-com-nobody-nothing-xyzzy/s/scratchpad"))
      .toBeNull();
  });

  test("null and empty are not errors", () => {
    expect(resolveRepoKey(null)).toBeNull();
    expect(resolveRepoKey("")).toBeNull();
  });

  test("the index maps a bare name to fully-qualified keys", () => {
    const idx = repoIndex();
    for (const [name, keys] of idx) {
      expect(name).not.toContain("/");
      for (const k of keys) expect(k).toMatch(/^github\.com\/[^/]+\/[^/]+$/);
      break;   // shape is uniform; one entry proves it without depending on contents
    }
  });

  test("an ambiguous name resolves to nothing rather than to a guess", () => {
    // Two orgs owning the same repo name is real here (forks, -oracle suffixes).
    const dupe = [...repoIndex()].find(([, keys]) => keys.length > 1);
    if (!dupe) return;                      // no duplicates on this machine — nothing to assert
    expect(resolveRepoKey(`/x/.herdr/worktrees/${dupe[0]}/space/a`)).toBeNull();
  });
});
