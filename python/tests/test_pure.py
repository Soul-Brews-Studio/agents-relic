"""Pure-function tests — no LanceDB, no filesystem, no fixtures.

Ported case-for-case from the TypeScript suite, because these are not hypotheticals:
every case here is a bug that ACTUALLY SHIPPED in the reference implementation and was
found by hand. A port that does not carry them forward gets to rediscover all of them.
"""

from relicpy.models import DEFAULT_BANK
from relicpy.query import dedupe_hits, group_by_bank, group_transcripts, max_iso, session_id_of_path
from relicpy.models import ShardStat
from relicpy.repo import repo_key_of, shard_dir_for


class TestSessionIdOfPath:
    """The uuid sits at a different depth in every shape."""

    def test_claude_session_uuid_is_the_basename(self):
        assert session_id_of_path(
            "/r/-opt-Code-x/04d1d650-031a-44f6-9c22-3e400e68390f.jsonl"
        ) == "04d1d650-031a-44f6-9c22-3e400e68390f"

    def test_claude_subagent_uuid_is_two_dirs_up_not_the_basename(self):
        # Parsing the basename made a subagent file report its AGENT NAME where a
        # session id belongs — which reads like a valid answer and is not one.
        assert session_id_of_path(
            "/r/-opt-x/04d1d650-031a-44f6-9c22-3e400e68390f/subagents/fable-uid.jsonl"
        ) == "04d1d650-031a-44f6-9c22-3e400e68390f"

    def test_claude_workflow_agent_uuid_is_four_dirs_up(self):
        assert session_id_of_path(
            "/r/-opt-x/04d1d650-031a-44f6-9c22-3e400e68390f/subagents/workflows/"
            "wf_abc/agent-7.jsonl"
        ) == "04d1d650-031a-44f6-9c22-3e400e68390f"

    def test_codex_uuid_follows_a_timestamp_in_the_basename(self):
        assert session_id_of_path(
            "/c/sessions/2026/09/18/rollout-2026-09-18T10-00-00-"
            "04d1d650-031a-44f6-9c22-3e400e68390f.jsonl"
        ) == "04d1d650-031a-44f6-9c22-3e400e68390f"

    def test_omp_has_no_uuid_so_the_id_follows_the_underscore(self):
        assert session_id_of_path("/o/--opt-x--/20260918T100000_abc123.jsonl",
                                  "omp") == "abc123"

    def test_a_vault_note_has_no_session_at_all(self):
        assert session_id_of_path("/repo/psi/memory/learnings/2026-09-18_thing.md") == ""

    def test_uppercase_uuid_normalises(self):
        assert session_id_of_path("/r/p/04D1D650-031A-44F6-9C22-3E400E68390F.jsonl") \
            == "04d1d650-031a-44f6-9c22-3e400e68390f"


class TestDedupeHits:
    """The key is CONTENT, not uid."""

    def test_keeps_two_different_events_that_share_a_uid(self):
        # uid hashes a LINE SLOT. A resumed session writes a new file under the same
        # uuid holding none of the earlier lines, so slot 7 holds two different events.
        out = dedupe_hits([
            {"uid": "same", "ts": "2026-09-01T00:00:00Z", "role": "user", "text": "first"},
            {"uid": "same", "ts": "2026-09-02T00:00:00Z", "role": "user", "text": "second"},
        ])
        assert len(out) == 2

    def test_collapses_the_same_event_from_two_banks(self):
        out = dedupe_hits([
            {"uid": "a", "ts": "2026-09-01T00:00:00Z", "role": "user", "text": "hi"},
            {"uid": "b", "ts": "2026-09-01T00:00:00Z", "role": "user", "text": "hi"},
        ])
        assert len(out) == 1

    def test_same_text_different_role_is_two_events(self):
        out = dedupe_hits([
            {"uid": "a", "ts": "2026-09-01T00:00:00Z", "role": "user", "text": "ok"},
            {"uid": "b", "ts": "2026-09-01T00:00:00Z", "role": "assistant", "text": "ok"},
        ])
        assert len(out) == 2

    def test_falls_back_to_uid_when_there_is_no_timestamp(self):
        out = dedupe_hits([
            {"uid": "a", "ts": "", "role": "note", "text": "x"},
            {"uid": "a", "ts": "", "role": "note", "text": "x"},
            {"uid": "b", "ts": "", "role": "note", "text": "x"},
        ])
        assert len(out) == 2

    def test_preserves_order_of_first_appearance(self):
        out = dedupe_hits([
            {"uid": "a", "ts": "2026-09-02T00:00:00Z", "role": "user", "text": "second"},
            {"uid": "b", "ts": "2026-09-01T00:00:00Z", "role": "user", "text": "first"},
            {"uid": "c", "ts": "2026-09-02T00:00:00Z", "role": "user", "text": "second"},
        ])
        assert [h["text"] for h in out] == ["second", "first"]


def _stat(bank, repo, ev, se, li="", ns=""):
    return ShardStat(key=f"{bank}/{repo}", bank=bank, repo=repo, events=ev,
                     sessions=se, last_indexed=li, newest_session=ns)


class TestGroupByBank:
    ROWS = [
        _stat("projects", "github.com/a/x", 10, 1, "2026-09-18T10:00:00Z", "2026-09-01T00:00:00Z"),
        _stat("projects-archive", "github.com/a/x", 9, 9, "2026-09-17T10:00:00Z", "2026-09-16T00:00:00Z"),
        _stat("projects", "github.com/a/y", 50, 5, "2026-09-18T12:00:00Z", "2026-09-18T00:00:00Z"),
    ]

    def test_groups_by_bank_biggest_first(self):
        g = group_by_bank(self.ROWS)
        assert [b.bank for b in g] == ["projects", "projects-archive"]
        assert g[0].events == 60 and g[0].sessions == 6 and g[0].shards == 2

    def test_the_same_repo_in_two_banks_stays_two_rows(self):
        repos = [r.repo for b in group_by_bank(self.ROWS) for r in b.rows]
        assert repos.count("github.com/a/x") == 2

    def test_rows_inside_a_bank_are_biggest_first(self):
        assert [r.repo for r in group_by_bank(self.ROWS)[0].rows] == \
            ["github.com/a/y", "github.com/a/x"]

    def test_a_bank_folds_to_the_newest_timestamp_not_the_first_seen(self):
        g = group_by_bank(self.ROWS)[0]
        assert g.last_indexed == "2026-09-18T12:00:00Z"
        assert g.newest_session == "2026-09-18T00:00:00Z"


class TestMaxISO:
    def test_picks_the_newest(self):
        assert max_iso(["2026-09-01T00:00:00Z", "2026-09-18T00:00:00Z"]) \
            == "2026-09-18T00:00:00Z"

    def test_empty_and_none_lose_to_any_real_value(self):
        assert max_iso(["", None, "2026-01-01T00:00:00Z"]) == "2026-01-01T00:00:00Z"

    def test_all_empty_is_empty_not_none(self):
        # Callers render "" as "never"; None would render as the string "None".
        assert max_iso(["", None]) == "" and max_iso([]) == ""


class TestShardPaths:
    def test_bank_is_the_top_level_under_banks(self):
        assert shard_dir_for("github.com/acme/repo", "/data", False, "projects") \
            == "/data/banks/projects/github.com/acme/repo"

    def test_default_bank_when_none_given(self):
        assert shard_dir_for("github.com/acme/repo", "/data") \
            == f"/data/banks/{DEFAULT_BANK}/github.com/acme/repo"

    def test_unresolved_repo_still_lands_inside_its_bank(self):
        assert shard_dir_for(None, "/data", False, "codex") \
            == "/data/banks/codex/_unresolved"

    def test_repo_key_is_host_independent(self):
        # The same repo on three machines under three roots is ONE shard, not three.
        a = repo_key_of("/opt/Code/github.com/laris-co/neo-oracle")
        b = repo_key_of("/Users/someone/Code/github.com/laris-co/neo-oracle/wt/x")
        assert a == b == "github.com/laris-co/neo-oracle"


class TestGroupTranscripts:
    """Ported from `groupTranscripts` in src/query.ts — see issue #46.

    Without this a session that spawned N children reads as N+1 unrelated rows, each
    with its own event count, sorted into the list by their own timestamps.
    """

    def _row(self, repo, uuid, tier, started, events, file_path=None):
        return {"repo": repo, "session_uuid": uuid, "tier": tier,
               "started_at": started, "event_count": events,
               "file_path": file_path or f"/x/{uuid}.jsonl"}

    def test_a_parent_with_two_children_collapses_to_one_row(self):
        rows = [
            self._row("github.com/a/b", "u1", "session", "2026-09-01T00:00:00Z", 10),
            self._row("github.com/a/b", "u1", "subagent", "2026-09-01T00:01:00Z", 3),
            self._row("github.com/a/b", "u1", "workflow_agent", "2026-09-01T00:02:00Z", 5),
        ]
        out = group_transcripts(rows)
        assert len(out) == 1
        assert out[0]["children"] == 2
        assert out[0]["tree_events"] == 18
        assert out[0]["tier"] == "session"  # the parent row represents the group

    def test_missing_parent_falls_back_to_the_earliest_child(self):
        # Indexed without its own `session` row — a tree is never silently dropped.
        rows = [
            self._row("github.com/a/b", "u1", "subagent", "2026-09-01T00:05:00Z", 3),
            self._row("github.com/a/b", "u1", "subagent", "2026-09-01T00:01:00Z", 4),
        ]
        out = group_transcripts(rows)
        assert len(out) == 1
        assert out[0]["children"] == 1
        assert out[0]["started_at"] == "2026-09-01T00:01:00Z"

    def test_unrelated_sessions_stay_separate(self):
        rows = [
            self._row("github.com/a/b", "u1", "session", "2026-09-01T00:00:00Z", 10),
            self._row("github.com/a/b", "u2", "session", "2026-09-02T00:00:00Z", 7),
        ]
        out = group_transcripts(rows)
        assert len(out) == 2
        assert {r["children"] for r in out} == {0}

    def test_same_uuid_different_repo_does_not_merge(self):
        # session_uuid is not a key ACROSS shards — the caveat this issue calls out.
        # Two different repos sharing a uuid (overlapping banks) must stay two trees,
        # not one with a doubled event count.
        rows = [
            self._row("github.com/a/one", "same", "session", "2026-09-01T00:00:00Z", 10),
            self._row("github.com/a/two", "same", "session", "2026-09-01T00:00:00Z", 20),
        ]
        out = group_transcripts(rows)
        assert len(out) == 2
        assert {r["tree_events"] for r in out} == {10, 20}
