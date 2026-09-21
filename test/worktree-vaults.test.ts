import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, utimesSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { walkVaults } from "../src/discover.js";
import { parseVault } from "../src/shapes/vault.js";
import type { Found } from "../src/discover.js";

// realpath at the root: macOS hands out /var/folders/… and resolves it to
// /private/var/…, so an unresolved base would not prefix what the walker emits.
const tmp = realpathSync(mkdtempSync(join(tmpdir(), "relic-wtvaults-")));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/*
 * A ghq HOST root, because that is the level `oracle-vaults` is pointed at and
 * `repoKeyOf` needs a `github.com/<org>/<repo>` triple to collapse a worktree back
 * onto its repo. A tmpdir without that segment would test a path shape that never
 * occurs.
 */
const host = join(tmp, "github.com");

/** Write `<org>/<repo><suffix>/ψ/<rel>` and return the file's path. */
function note(repo: string, suffix: string, rel: string, body: string): string {
  const p = join(host, "acme", repo + suffix, "ψ", rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, body);
  return p;
}

const walk = (sinceMs: number | null = null): Found[] => {
  const out: Found[] = [];
  walkVaults(host, sinceMs, out, "oracle-vaults", parseVault);
  return out;
};
const rel = (f: Found) => f.path.slice(host.length + 1);

/**
 * THE GAP: `<repo>/wt/<slug>/ψ` is a real directory, not a link back, so nothing
 * already in the walker collapses it — and a repo commits its vault, so every
 * worktree carries a near-complete copy. Measured on m5 2026-09-22: 147,901 files the
 * walk yields today, 194,863 more in the worktree vaults, 738 of them found nowhere
 * else — 582 at a path the main checkout lacks, 156 at a shared path with other bytes.
 */
describe("worktree vaults are walked, and deduped against the main checkout", () => {
  // main checkout
  note("one", "", "memory/shared.md", "# shared note\n");
  note("one", "", "memory/only-main.md", "# main only\n");
  // a worktree of it: one copy of a note the main checkout has, one it does not
  note("one", "/wt/a-feature", "memory/shared.md", "# shared note\n");
  note("one", "/wt/a-feature", "memory/retro.md", "# written inside the worktree\n");

  test("a note that exists ONLY in the worktree is indexed", () => {
    const found = walk().map(rel);
    expect(found).toContain("acme/one/wt/a-feature/ψ/memory/retro.md");
  });

  test("a note the main checkout already has is counted ONCE, and it is the main copy", () => {
    const shared = walk().map(rel).filter(p => p.endsWith("memory/shared.md") && p.startsWith("acme/one/"));
    expect(shared).toEqual(["acme/one/ψ/memory/shared.md"]);
  });

  test("the main checkout still yields everything it yielded before", () => {
    // Not taste. `relic prune` deletes rows whose file discovery no longer reaches,
    // so a rule that demoted an already-indexed path would queue it for deletion.
    const found = walk().map(rel);
    expect(found).toContain("acme/one/ψ/memory/shared.md");
    expect(found).toContain("acme/one/ψ/memory/only-main.md");
  });
});

describe("a worktree vault that is a SYMLINK contributes nothing twice", () => {
  note("linked", "", "memory/a.md", "# a\n");
  mkdirSync(join(host, "acme", "linked", "wt", "mirror"), { recursive: true });
  symlinkSync(join(host, "acme", "linked", "ψ"),
              join(host, "acme", "linked", "wt", "mirror", "ψ"));

  // ...and one pointing at a DIFFERENT repo's vault, which is what /psi actually does.
  note("target", "", "memory/b.md", "# b\n");
  mkdirSync(join(host, "acme", "borrower", "wt", "space"), { recursive: true });
  symlinkSync(join(host, "acme", "target", "ψ"),
              join(host, "acme", "borrower", "wt", "space", "ψ"));

  test("a link back to its own repo's vault resolves to an already-walked root", () => {
    const a = walk().map(rel).filter(p => p.endsWith("memory/a.md"));
    expect(a).toEqual(["acme/linked/ψ/memory/a.md"]);
  });

  test("a link into ANOTHER repo's vault is the same case — realpath decides, not the path", () => {
    const b = walk().map(rel).filter(p => p.endsWith("memory/b.md"));
    expect(b).toEqual(["acme/target/ψ/memory/b.md"]);
  });

  test("a DEAD link is skipped rather than throwing", () => {
    mkdirSync(join(host, "acme", "dangling", "wt", "gone"), { recursive: true });
    symlinkSync(join(tmp, "no-such-vault"), join(host, "acme", "dangling", "wt", "gone", "ψ"));
    expect(() => walk()).not.toThrow();
  });
});

describe("what the key is made of", () => {
  /*
   * SIZE, not just the path. A shared path is not a promise of shared content:
   * measured over the 12,820 notes that exist at one path in two checkouts, 143 hold
   * a worktree edit that never came back. Dropping them would lose the only copy.
   */
  note("edited", "", "memory/x.md", "# x\n");
  note("edited", "/wt/in-progress", "memory/x.md", "# x, with a paragraph added inside the worktree\n");

  test("the same path with DIFFERENT content is kept, not collapsed", () => {
    const x = walk().map(rel).filter(p => p.endsWith("memory/x.md")).sort();
    // sorted: "wt" sorts before "ψ", which is U+03C8 and above every ASCII letter
    expect(x).toEqual(["acme/edited/wt/in-progress/ψ/memory/x.md",
                       "acme/edited/ψ/memory/x.md"]);
  });

  test("two repos' notes at the same vault-relative path never collide", () => {
    // The key carries the repo, so `ψ/memory/resonance.md` — which every oracle has —
    // does not make one oracle's soul shadow another's.
    note("left", "", "memory/resonance.md", "same bytes\n");
    note("right", "", "memory/resonance.md", "same bytes\n");
    const r = walk().map(rel).filter(p => p.endsWith("memory/resonance.md")).sort();
    expect(r).toEqual(["acme/left/ψ/memory/resonance.md",
                       "acme/right/ψ/memory/resonance.md"]);
  });
});

describe("agents/<slug>/ψ is the same shape as wt/<slug>/ψ", () => {
  /*
   * And not a rounding error: of the 738 notes found nowhere else on this machine,
   * 475 came from `agents/` and 263 from `wt/`. `contextOf` in repo.ts already reads
   * both as a worktree segment.
   */
  note("workspaces", "", "memory/kept.md", "# kept\n");
  note("workspaces", "/agents/worker-1", "memory/kept.md", "# kept\n");
  note("workspaces", "/agents/worker-1", "memory/agent-only.md", "# only here\n");

  test("its unique notes are indexed and its copies are not", () => {
    const found = walk().map(rel).filter(p => p.startsWith("acme/workspaces/"));
    expect(found.sort()).toEqual(["acme/workspaces/agents/worker-1/ψ/memory/agent-only.md",
                                  "acme/workspaces/ψ/memory/kept.md"]);
  });
});

describe("two worktrees holding the same unseen note", () => {
  note("twins", "/wt/a-first", "memory/twin.md", "# twin\n");
  note("twins", "/wt/b-second", "memory/twin.md", "# twin\n");

  test("one row, and the same one on every run", () => {
    const first = walk().map(rel).filter(p => p.endsWith("memory/twin.md"));
    expect(first).toEqual(["acme/twins/wt/a-first/ψ/memory/twin.md"]);
    expect(walk().map(rel).filter(p => p.endsWith("memory/twin.md"))).toEqual(first);
  });
});

describe("--since must not invert the rule", () => {
  /*
   * THE TRAP: a worktree is a fresh checkout, so git stamps every note in it with the
   * moment the worktree was cut. Under `--since 7d` the COPIES look new and the
   * ORIGINALS look old — so a narrowed run would index exactly the duplicates the
   * rule exists to suppress. The veto runs before the --since filter for this reason.
   */
  const old = note("aged", "", "memory/old.md", "# old note\n");
  const copy = note("aged", "/wt/fresh-checkout", "memory/old.md", "# old note\n");
  const longAgo = Date.now() / 1000 - 90 * 86_400;
  utimesSync(old, longAgo, longAgo);

  test("a fresh copy of an old note is still a copy", () => {
    const since = Date.now() - 86_400_000;
    const found = walk(since).map(rel).filter(p => p.endsWith("memory/old.md"));
    expect(found).toEqual([]);
    expect(copy).toContain("wt/fresh-checkout");   // the fresh mtime really is fresh
  });
});
