"""Prune: what it removes, and everything it refuses to remove.

The interesting tests here are the refusals. Prune is the only code in relic that
deletes rows a human did not name, so a test that proves it CAN delete is the easy
half — the gates are the feature.
"""

from __future__ import annotations

from relicpy.importer import ImportTally, Shards
from relicpy.models import EventRow, FileRow, SessionRow
from relicpy.prune import DEFAULT_MAX_DROP_PCT, prune, prune_refusal, prune_totals
from relicpy.store import LanceStore


def ev(uid: str, file_path: str) -> EventRow:
    return EventRow(uid=uid, session_uuid="s", file_path=file_path, repo_key="r", seq=1.0,
                    role="user", ts="", text="hi", source="claude", tier="session",
                    kind="transcript", worktree="", cwd="", org="", project="", dir="",
                    mem_type="", origin_session="")


def se(file_path: str) -> SessionRow:
    return SessionRow(session_uuid="s", file_path=file_path, repo_key="r", project_dir="p",
                      tier="session", source="claude", cwd="", model="", worktree="",
                      workflow_run_id="", agent_id="", file_mtime=1.0, file_size=2.0,
                      line_count=1.0, event_count=1.0, bad_lines=0.0, started_at="",
                      ended_at="", description="", title="", git_branch="", imported_at="")


def fi(file_path: str) -> FileRow:
    return FileRow(file_path=file_path, repo_key="r", mtime=1.0, size=2.0, imported_at="")


SHARD = ("projects", "github.com/a/b")


def one_shard(tmp_path, name: str, indexed: list[str], discovered: list[str]):
    """A tally whose pool holds one real store under one shard key."""
    store = LanceStore.open(str(tmp_path / name))
    store.put_events([ev(f"u{i}", p) for i, p in enumerate(indexed)])
    store.put_sessions([se(p) for p in indexed])
    store.put_files([fi(p) for p in indexed])
    shards = Shards(None)
    shards._pool[SHARD] = store
    t = ImportTally(shards=shards, seen={SHARD: set(discovered)})
    return store, t


def test_indexed_files_counts_a_file_with_zero_events(tmp_path):
    # journal.jsonl parses to zero events, so it writes a session row and a file row and
    # NO event rows. 1,353 of them sat in the live index. Reading only `events` to
    # decide what is indexed would report this shard as already clean.
    s = LanceStore.open(str(tmp_path / "zero"))
    s.put_events([ev("u1", "/a/chat.jsonl")])
    s.put_sessions([se("/a/chat.jsonl"), se("/a/journal.jsonl")])
    s.put_files([fi("/a/chat.jsonl"), fi("/a/journal.jsonl")])
    assert s.indexed_files() == {"/a/chat.jsonl", "/a/journal.jsonl"}


def test_dry_run_and_real_run_report_the_same_numbers(tmp_path):
    s = LanceStore.open(str(tmp_path / "counts"))
    s.put_events([ev("u1", "/keep.jsonl"), ev("u2", "/drop.jsonl"), ev("u3", "/drop.jsonl")])
    s.put_sessions([se("/keep.jsonl"), se("/drop.jsonl")])
    s.put_files([fi("/keep.jsonl"), fi("/drop.jsonl")])

    dry = s.prune_files(["/drop.jsonl"], False)
    assert dry == {"events": 2, "sessions": 1, "files": 1, "vectors": 0}
    assert "/drop.jsonl" in s.indexed_files()      # a dry run that deletes is the failure

    assert s.prune_files(["/drop.jsonl"], True) == dry
    assert s.indexed_files() == {"/keep.jsonl"}


def test_vectors_go_with_their_events(tmp_path):
    # `vectors` reaches a file ONLY through events.uid. Delete the events first and
    # every embedding is stranded with nothing left to find it by — and stranded rows
    # are invisible, because vector_stats() counts rows, not reachable ones.
    s = LanceStore.open(str(tmp_path / "vectors"))
    s.put_events([ev("u1", "/keep.jsonl"), ev("u2", "/drop.jsonl")])
    s.put_files([fi("/keep.jsonl"), fi("/drop.jsonl")])
    s.put_vectors([{"uid": "u1", "embedding": [1.0, 0.0], "model": "t", "dim": 2,
                    "norm": "l2", "embedded_at": ""},
                   {"uid": "u2", "embedding": [0.0, 1.0], "model": "t", "dim": 2,
                    "norm": "l2", "embedded_at": ""}], dim=2)
    assert s.vector_stats()["rows"] == 2

    assert s.prune_files(["/drop.jsonl"], True)["vectors"] == 1
    assert s.vector_stats()["rows"] == 1
    assert s.embedded_uids() == {"u1"}


def test_empty_path_list_touches_nothing(tmp_path):
    s = LanceStore.open(str(tmp_path / "empty"))
    s.put_files([fi("/a")])
    assert s.prune_files([], True) == {"events": 0, "sessions": 0, "files": 0, "vectors": 0}
    assert len(s.indexed_files()) == 1


def test_since_is_refused():
    # An older file is not a deleted file.
    assert "--since narrows discovery" in prune_refusal(ImportTally(), 12345, None)


def test_repo_is_refused():
    assert "--repo narrows discovery" in prune_refusal(ImportTally(), None, "neo-oracle")


def test_a_parse_failure_blocks_the_whole_run():
    # A file that threw was DISCOVERED. It is present on disk and absent from `seen`,
    # which is indistinguishable from deleted.
    assert "failed to parse" in prune_refusal(ImportTally(failed=1), None, None)


def test_a_full_clean_scan_is_allowed():
    assert prune_refusal(ImportTally(), None, None) is None


def test_drops_exactly_what_discovery_stopped_yielding(tmp_path):
    files = [f"/f{i}.jsonl" for i in range(20)]
    store, t = one_shard(tmp_path, "plan", files, files[1:])        # 1 of 20 = 5%
    plan = prune(t, apply=True, data_root=str(tmp_path / "no-such-root"))
    assert plan.refused is None
    assert plan.shards[0].drop == ["/f0.jsonl"]
    assert prune_totals(plan)["files"] == 1
    assert "/f0.jsonl" not in store.indexed_files()


def test_the_ceiling_refuses_a_shard_and_leaves_it_untouched(tmp_path):
    # The bug this gate exists for: ghq.root was unset on white.local, so
    # resolve_repo_key returned None for every file and everything sharded to
    # _unresolved. Gates 1-3 all pass in that state and the index deletes itself while
    # printing a clean summary.
    files = [f"/f{i}.jsonl" for i in range(20)]
    store, t = one_shard(tmp_path, "ceiling", files, files[:5])     # 75% gone
    plan = prune(t, apply=True, data_root=str(tmp_path / "no-such-root"))
    assert "ceiling 10%" in plan.shards[0].blocked
    assert plan.shards[0].removed is None
    assert len(store.indexed_files()) == 20
    assert prune_totals(plan)["blocked"] == 1


def test_force_gets_past_the_ceiling(tmp_path):
    files = [f"/f{i}.jsonl" for i in range(20)]
    store, t = one_shard(tmp_path, "forced", files, files[:5])
    plan = prune(t, apply=True, force=True, data_root=str(tmp_path / "no-such-root"))
    assert plan.shards[0].blocked is None
    assert len(plan.shards[0].drop) == 15
    assert len(store.indexed_files()) == 5


def test_a_clean_shard_reports_nothing(tmp_path):
    files = ["/a.jsonl", "/b.jsonl"]
    _, t = one_shard(tmp_path, "clean", files, files)
    plan = prune(t, apply=True, data_root=str(tmp_path / "no-such-root"))
    assert plan.shards[0].drop == []
    assert prune_totals(plan) == {"files": 0, "events": 0, "sessions": 0, "vectors": 0,
                                  "shards": 0, "blocked": 0}


def test_a_refused_run_looks_at_no_shard_at_all(tmp_path):
    files = ["/a.jsonl", "/b.jsonl"]
    store, t = one_shard(tmp_path, "refused", files, [])
    plan = prune(t, apply=True, repo_filter="x", data_root=str(tmp_path / "no-such-root"))
    assert "--repo" in plan.refused
    assert plan.shards == []
    assert len(store.indexed_files()) == 2


def test_default_ceiling_is_ten_percent():
    assert DEFAULT_MAX_DROP_PCT == 10


def test_a_file_that_moved_shard_is_still_on_disk(tmp_path):
    """MEASURED ON THE LIVE INDEX, and why prune compares against one global set.

    Two memory notes had rows in `memory/_unresolved` and now resolve to
    `memory/github.com/laris-co/neo-oracle` — a memory note takes its cwd from the
    session that produced it, and that session was not indexed yet when the note was
    first written. Per-shard comparison called both DELETED. Both are on disk, and a
    prune-only run writes no replacement.
    """
    moved, gone = "/m/note.md", "/m/journal.jsonl"
    old = LanceStore.open(str(tmp_path / "moved-old"))
    old.put_events([ev("u1", moved)])
    old.put_sessions([se(moved), se(gone)])
    old.put_files([fi(moved), fi(gone)])

    old_key = ("memory", "_unresolved")
    new_key = ("memory", "github.com/laris-co/neo-oracle")
    shards = Shards(None)
    shards._pool[old_key] = old
    shards._pool[new_key] = LanceStore.open(str(tmp_path / "moved-new"))

    # The file WAS discovered — under the new shard, not the old one.
    t = ImportTally(shards=shards, seen={old_key: set(), new_key: {moved}})
    plan = prune(t, apply=True, max_drop_pct=100.0,
                 data_root=str(tmp_path / "no-such-root"))

    old_plan = next(x for x in plan.shards if x.repo == "_unresolved")
    assert old_plan.drop == [gone]                 # NOT the moved file
    assert old.indexed_files() == {moved}
