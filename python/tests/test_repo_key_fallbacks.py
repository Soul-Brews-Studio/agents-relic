"""Issue #64, Python side — same rules as test/repo-key-fallbacks.test.ts."""

from __future__ import annotations

import os

import pytest

from relicpy.repo import (context_of, list_shards, mapped_repo_key, parse_repo_mappings, remote_repo_key,
                          remote_to_key, repo_key_of, reset_repo_index)


@pytest.fixture(autouse=True)
def _fresh():
    reset_repo_index()
    yield
    reset_repo_index()


def make_repo(d, origin):
    os.makedirs(os.path.join(d, ".git"), exist_ok=True)
    with open(os.path.join(d, ".git", "config"), "w") as f:
        f.write("[core]\n\tbare = false\n")
        if origin:
            f.write(f'[remote "origin"]\n\turl = {origin}\n')


def test_other_forge_hosts_key_on_their_own_host():
    assert repo_key_of("/opt/Code/gitlab.com/acme/tool") == "gitlab.com/acme/tool"
    assert repo_key_of("/home/x/src/bitbucket.org/acme/app/wt/fix") == "bitbucket.org/acme/app"
    assert repo_key_of("/opt/Code/github.com/acme/thing/vendor/gitlab.com/x/y") == "github.com/acme/thing"
    assert context_of("/opt/Code/gitlab.com/acme/tool/wt/big-fix/src")["worktree"] == "big-fix"


@pytest.mark.parametrize("url,key", [
    ("git@github.com:acme/thing.git", "github.com/acme/thing"),
    ("ssh://git@gitlab.com:2222/acme/tool.git", "gitlab.com/acme/tool"),
    ("https://user:secret@GitHub.com/acme/thing.git/", "github.com/acme/thing"),
    ("https://gitlab.com/group/sub/repo.git", None),
    ("/srv/git/repo.git", None),
    ("git@localhost:acme/thing.git", None),
])
def test_remote_to_key(url, key):
    assert remote_to_key(url) == key


def test_remote_fallback_resolves_a_checkout_outside_ghq(tmp_path):
    atom = str(tmp_path / "atom")
    make_repo(atom, "git@github.com:thebuilderofmoebius9/atom-discord-bridge.git")
    os.makedirs(os.path.join(atom, "src"))
    assert remote_repo_key(os.path.join(atom, "src"), home="/nonexistent-home") \
        == "github.com/thebuilderofmoebius9/atom-discord-bridge"


def test_worktree_reads_config_through_commondir(tmp_path):
    main = str(tmp_path / "main")
    make_repo(main, "https://gitlab.com/acme/tool.git")
    gitdir = os.path.join(main, ".git", "worktrees", "wt1")
    os.makedirs(gitdir)
    with open(os.path.join(gitdir, "commondir"), "w") as f:
        f.write("../..\n")
    wt = str(tmp_path / "elsewhere" / "wt1")
    os.makedirs(wt)
    with open(os.path.join(wt, ".git"), "w") as f:
        f.write(f"gitdir: {gitdir}\n")
    assert remote_repo_key(wt, home="/nonexistent-home") == "gitlab.com/acme/tool"


def test_nearest_repo_decides_gone_dir_and_home_guard(tmp_path):
    outer = str(tmp_path / "outer")
    make_repo(outer, "git@github.com:acme/outer.git")
    inner = os.path.join(outer, "inner")
    make_repo(inner, None)
    assert remote_repo_key(inner, home="/nonexistent-home") is None
    assert remote_repo_key(os.path.join(outer, "deleted"), home="/nonexistent-home") is None
    os.makedirs(os.path.join(outer, "scratch"))
    assert remote_repo_key(os.path.join(outer, "scratch"), home=outer) is None


def test_mappings_longest_prefix_and_validation():
    warns = []
    m = parse_repo_mappings({"repo_mappings": {
        "/home/a/atom": "github.com/o/atom-bridge",
        "/home/a/atom/deep": "gitlab.com/g/deep",
        "~/work/": "codeberg.org/me/work",
        "/root/labs/hello": "local/hello",
    }}, "/home/a", warns.append)
    assert mapped_repo_key("/home/a/atom/src", m) == "github.com/o/atom-bridge"
    assert mapped_repo_key("/home/a/atom/deep/y", m) == "gitlab.com/g/deep"
    assert mapped_repo_key("/home/a/atomic", m) is None
    assert mapped_repo_key("/home/a/work/x", m) == "codeberg.org/me/work"
    assert len(m) == 3 and len(warns) == 1


def test_list_shards_includes_other_hosts(tmp_path):
    for d in ("github.com/o/r", "gitlab.com/g/t", "_unresolved"):
        os.makedirs(tmp_path / "banks" / "b" / d)
    keys = sorted(s.key for s in list_shards(str(tmp_path)))
    assert keys == ["b/_unresolved", "b/github.com/o/r", "b/gitlab.com/g/t"]
