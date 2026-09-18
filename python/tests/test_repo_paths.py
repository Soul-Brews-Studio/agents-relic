"""Path -> shard decisions. Every case here is a real shard-count bug."""

from relicpy.repo import context_of, location_of, repo_key_of


class TestRepoKey:
    def test_host_independent(self):
        # The same repo under four roots is ONE shard, not four.
        a = repo_key_of("/opt/Code/github.com/acme/my-repo")
        b = repo_key_of("/Users/someone/ghq/github.com/acme/my-repo/wt/x")
        c = repo_key_of("/home/ci/ghq/github.com/acme/my-repo/ψ/lab/thing")
        assert a == b == c == "github.com/acme/my-repo"

    def test_sibling_worktrees_collapse_into_their_repo(self):
        # An older convention puts worktrees BESIDE the repo. Leaving this out of the
        # port made homekeeper-oracle.wt-1-bridge and .wt-2-white two extra shards —
        # Python wrote 28 where the reference wrote 27.
        assert repo_key_of("/opt/Code/github.com/acme/my-repo.wt-5-feature") \
            == "github.com/acme/my-repo"
        assert repo_key_of("/opt/Code/github.com/acme/my-repo.omx-worktrees") \
            == "github.com/acme/my-repo"

    def test_a_genuinely_dotted_repo_is_not_mangled(self):
        # Only the exact markers are stripped; a blanket "cut at the first dot" would
        # break a real repo name.
        assert repo_key_of("/opt/Code/github.com/acme/my.repo.js") \
            == "github.com/acme/my.repo.js"

    def test_incubate_worktrees_drop_the_host_segment(self):
        assert repo_key_of("/x/incubate/worktrees/acme/my-repo/src") \
            == "github.com/acme/my-repo"

    def test_unresolvable_is_none_not_a_guess(self):
        assert repo_key_of("/tmp/somewhere") is None
        assert repo_key_of(None) is None


class TestContext:
    def test_four_worktree_conventions(self):
        # A naive "look for /wt/" finds only one of these. The first cut of the port
        # did exactly that and left 18 of 198 rows with an empty worktree.
        assert context_of("/o/github.com/a/r/wt/slug")["worktree"] == "slug"
        assert context_of("/o/github.com/a/r/agents/codex")["worktree"] == "agents/codex"
        assert context_of("/o/github.com/a/r/ψ/lab/03-fb")["worktree"] == "lab/03-fb"
        assert context_of("/o/github.com/a/r.wt-1-bridge")["worktree"] == "wt-1-bridge"

    def test_plain_checkout_has_no_worktree(self):
        assert context_of("/o/github.com/a/r/src")["worktree"] == ""


class TestLocation:
    def test_project_containers_name_the_inner_project(self):
        assert location_of("/o/github.com/a/r/ψ/lab/my-lab/x.md")["project"] == "my-lab"
        assert location_of("/o/github.com/a/r/ψ/learn/thing/x.md")["project"] == "thing"

    def test_incubate_names_the_incubated_repo_not_the_org(self):
        loc = location_of("/o/github.com/a/r/ψ/incubate/Soul-Brews/agents-relic/src")
        assert loc["project"] == "agents-relic"

    def test_dir_excludes_the_worktree_and_the_filename(self):
        # Leaving the worktree in duplicates a facet that has its own column; leaving
        # the filename in makes --dir match one file instead of a tree.
        loc = location_of("/o/github.com/a/r/wt/slug/ψ/memory/learnings/x.md")
        assert loc["worktree"] == "slug"
        assert loc["dir"] == "ψ/memory/learnings"
