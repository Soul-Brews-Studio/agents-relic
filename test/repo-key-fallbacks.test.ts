import { expect, test, describe, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoKeyOf, resolveRepoKey, contextOf, locationOf, listShards, remoteToKey, remoteRepoKey,
         parseRepoMappings, mappedRepoKey, resetRepoIndex } from "../src/repo.js";

// Issue #64: sessions outside a `github.com/<org>/<repo>` path all landed in `_unresolved`.
const tmp = mkdtempSync(join(tmpdir(), "relic-repokey-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeEach(() => resetRepoIndex());

function repo(dir: string, origin: string | null) {
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"),
    `[core]\n\tbare = false\n` + (origin ? `[remote "origin"]\n\turl = ${origin}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n` : ""));
}

describe("repoKeyOf — every forge host ghq lays out, not only github.com", () => {
  test("gitlab, bitbucket and codeberg paths key on their own host", () => {
    expect(repoKeyOf("/opt/Code/gitlab.com/acme/tool")).toBe("gitlab.com/acme/tool");
    expect(repoKeyOf("/home/x/src/bitbucket.org/acme/app/wt/fix")).toBe("bitbucket.org/acme/app");
    expect(repoKeyOf("/ghq/codeberg.org/who/what/agents/one")).toBe("codeberg.org/who/what");
  });

  test("github.com is unchanged, and the FIRST host in the path wins", () => {
    expect(repoKeyOf("/opt/Code/github.com/acme/thing")).toBe("github.com/acme/thing");
    expect(repoKeyOf("/opt/Code/github.com/acme/thing/vendor/gitlab.com/x/y")).toBe("github.com/acme/thing");
  });

  test("worktree and location facets work for other hosts too", () => {
    expect(contextOf("/opt/Code/gitlab.com/acme/tool/wt/big-fix/src").worktree).toBe("big-fix");
    expect(locationOf("/opt/Code/gitlab.com/acme/tool/src/a.ts")).toMatchObject({ org: "acme", repo: "tool" });
  });
});

describe("remoteToKey — an origin URL, normalised", () => {
  test.each([
    ["git@github.com:acme/thing.git", "github.com/acme/thing"],
    ["github.com:acme/thing", "github.com/acme/thing"],
    ["ssh://git@gitlab.com:2222/acme/tool.git", "gitlab.com/acme/tool"],
    ["https://github.com/acme/thing", "github.com/acme/thing"],
    ["https://user:secret@GitHub.com/acme/thing.git/", "github.com/acme/thing"],
    ["https://git.example.org/team/app.git", "git.example.org/team/app"],
  ])("%s", (url, key) => expect(remoteToKey(url)).toBe(key));

  test.each([
    ["https://gitlab.com/group/sub/repo.git"],   // nested group: no <org>/<repo> shard
    ["/srv/git/repo.git"],                        // a local path is not an identity
    ["file:///srv/git/repo.git"],
    ["git@localhost:acme/thing.git"],             // not a domain
  ])("%s -> null", url => expect(remoteToKey(url)).toBeNull());
});

describe("remoteRepoKey — the git-remote fallback", () => {
  const home = join(tmp, "home");

  test("a checkout outside ghq resolves through its origin, from any subdirectory", () => {
    const atom = join(tmp, "atom");
    repo(atom, "git@github.com:thebuilderofmoebius9/atom-discord-bridge.git");
    mkdirSync(join(atom, "src"), { recursive: true });
    expect(remoteRepoKey(join(atom, "src"), home)).toBe("github.com/thebuilderofmoebius9/atom-discord-bridge");
    expect(resolveRepoKey(atom)).toBe("github.com/thebuilderofmoebius9/atom-discord-bridge");
  });

  test("a linked worktree reads the main repo's config through commondir", () => {
    const main = join(tmp, "main");
    repo(main, "https://gitlab.com/acme/tool.git");
    const gitdir = join(main, ".git", "worktrees", "wt1");
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, "commondir"), "../..\n");
    const wt = join(tmp, "elsewhere", "wt1");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), `gitdir: ${gitdir}\n`);
    expect(remoteRepoKey(wt, home)).toBe("gitlab.com/acme/tool");
  });

  test("the NEAREST repo decides — one without an origin does not borrow its parent's", () => {
    const outer = join(tmp, "outer");
    repo(outer, "git@github.com:acme/outer.git");
    const inner = join(outer, "inner");
    repo(inner, null);
    expect(remoteRepoKey(inner, home)).toBeNull();
  });

  test("a directory that is gone resolves to nothing, even inside a live repo", () => {
    const r = join(tmp, "live");
    repo(r, "git@github.com:acme/live.git");
    expect(remoteRepoKey(join(r, "deleted-worktree"), home)).toBeNull();
  });

  test("the walk stops before $HOME, so a dotfiles repo cannot claim everything under it", () => {
    const h = join(tmp, "dotfiles-home");
    repo(h, "git@github.com:me/dotfiles.git");
    mkdirSync(join(h, "scratch"), { recursive: true });
    expect(remoteRepoKey(join(h, "scratch"), h)).toBeNull();
  });

  test("cached per cwd — a second lookup does not re-read the config", () => {
    const r = join(tmp, "cached");
    repo(r, "git@github.com:acme/first.git");
    expect(remoteRepoKey(r, home)).toBe("github.com/acme/first");
    repo(r, "git@github.com:acme/second.git");
    expect(remoteRepoKey(r, home)).toBe("github.com/acme/first");
    resetRepoIndex();
    expect(remoteRepoKey(r, home)).toBe("github.com/acme/second");
  });
});

describe("repo_mappings — the explicit override", () => {
  const home = "/home/axezii";
  const warns: string[] = [];
  const maps = parseRepoMappings({
    repo_mappings: {
      "/home/axezii/atom": "github.com/thebuilderofmoebius9/atom-discord-bridge",
      "/home/axezii/atom/deep": "gitlab.com/g/deep",
      "~/work/": "codeberg.org/me/work",
      "/root/labs/hello": "local/hello",   // not <host>/<org>/<repo>: ignored, loudly
      "relative/path": "github.com/a/b",   // not absolute: ignored
    },
  }, home, m => warns.push(m));

  test("longest prefix wins, on a path boundary", () => {
    expect(mappedRepoKey("/home/axezii/atom", maps)).toBe("github.com/thebuilderofmoebius9/atom-discord-bridge");
    expect(mappedRepoKey("/home/axezii/atom/src/x", maps)).toBe("github.com/thebuilderofmoebius9/atom-discord-bridge");
    expect(mappedRepoKey("/home/axezii/atom/deep/y", maps)).toBe("gitlab.com/g/deep");
    expect(mappedRepoKey("/home/axezii/atomic", maps)).toBeNull();
  });

  test("~ expands and a trailing slash is ignored", () => {
    expect(mappedRepoKey("/home/axezii/work/a", maps)).toBe("codeberg.org/me/work");
  });

  test("invalid entries are dropped and named, never guessed at", () => {
    expect(maps.length).toBe(3);
    expect(warns.length).toBe(2);
    expect(warns.join("\n")).toContain("local/hello");
  });

  test("a mapping beats every path rule, including a github.com path", () => {
    const m = parseRepoMappings({ repo_mappings: { "/opt/Code/github.com/acme/old-name": "github.com/acme/new-name" } }, home);
    expect(mappedRepoKey("/opt/Code/github.com/acme/old-name/wt/x", m)).toBe("github.com/acme/new-name");
  });

  test("no config means no mappings", () => {
    expect(parseRepoMappings(null, home)).toEqual([]);
    expect(parseRepoMappings({}, home)).toEqual([]);
  });
});

describe("listShards — every host under a bank is a shard, like the native binary already walks", () => {
  test("a gitlab shard is listed beside github and _unresolved", () => {
    const root = join(tmp, "index");
    for (const d of ["github.com/o/r", "gitlab.com/g/t", "_unresolved"])
      mkdirSync(join(root, "banks", "b", d), { recursive: true });
    expect(listShards(root).map(s => s.key).sort()).toEqual(["b/_unresolved", "b/github.com/o/r", "b/gitlab.com/g/t"]);
  });
});
