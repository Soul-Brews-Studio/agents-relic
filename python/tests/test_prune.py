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


def test_source_path_override(tmp_path):
    """`--source-path` was documented in sources.py before it existed — the comment told
    you to run a command that fails. Pin the behaviour so it stays true."""
    from relicpy.discover import discover

    vault = tmp_path / "wt" / "some-worktree" / "ψ" / "memory" / "learnings"
    vault.mkdir(parents=True)
    (vault / "a-note.md").write_text("---\nname: a\n---\n\nsome learning text here\n")
    (vault / "b-note.md").write_text("---\nname: b\n---\n\nanother learning text\n")
    root = str(tmp_path / "wt" / "some-worktree" / "ψ")

    found = discover(["oracle-vault"], None, ("oracle-vault", root))
    assert sorted(f.path.rsplit("/", 1)[-1] for f in found) == ["a-note.md", "b-note.md"]
    # The walker, parser and BANK are unchanged — only the root moves. An override that
    # also changed the bank would scatter one source across two.
    assert found[0].source == "oracle-vault"
    assert found[0].bank == "vault"

    # The key must match, or this silently redirects the wrong source. Asserted as "no
    # result came from the override root", not as an empty list: oracle-vault's real
    # path is per-machine, and the first version of this assertion failed against
    # 10,129 real files. An environment-dependent assertion tests the machine, not the
    # code.
    assert [f for f in discover(["oracle-vault"], None, ("codex", root))
            if f.path.startswith(root)] == []


# --------------------------------------------------- index hygiene (#31, #35, #36)

def _write(tmp_path, name, *lines):
    f = tmp_path / name
    f.write_text("".join(lines))
    return str(f)


def _user(cwd, text):
    import json
    return json.dumps({"type": "user", "uuid": "u", "sessionId": "s", "cwd": cwd,
                       "timestamp": "2026-09-20T00:00:00Z",
                       "message": {"role": "user", "content": text}}) + "\n"


def test_cwd_is_an_event_property_not_a_file_property(tmp_path):
    """Before this, the parser kept the FIRST cwd and the importer stamped it on every
    event. Session 2bb9b553: 201 of 4,068 events were in a different worktree and
    `--worktree` could not reach any of them."""
    from relicpy.shapes.claude import parse
    f = _write(tmp_path, "two-repos.jsonl",
               _user("/repo/a", "first repo work here"),
               _user("/repo/a", "still the first repo"),
               _user("/repo/b", "moved to the second repo"))
    p = parse(f)
    assert [e.cwd for e in p.events] == ["/repo/a", "/repo/a", "/repo/b"]
    # Findable, not attributable: repo_key and the shard still come from p.cwd.
    assert p.cwd == "/repo/a"


SIG = "CAQS3QYKEAgRGAI4AUIIdG" + "A" * 1138


def test_hashed_thinking_never_becomes_an_event(tmp_path):
    """90.7% of thinking blocks are hashed — thinking:"" plus a ~1,160-char signature.
    Adding `signature` to the keys flatten_content reads, or loosening the falsy check,
    puts 32,386 x ~1,160 chars = ~37 MB of base64 into the FTS index. NOTHING WOULD
    FAIL. That is why this test exists."""
    import json
    from relicpy.shapes.claude import parse
    f = _write(tmp_path, "hashed.jsonl", json.dumps({
        "type": "assistant", "uuid": "u", "sessionId": "s", "cwd": "/r",
        "message": {"role": "assistant",
                    "content": [{"type": "thinking", "thinking": "", "signature": SIG}]}}) + "\n")
    assert parse(f).events == []


def test_the_signature_never_reaches_any_event_text(tmp_path):
    # Asserted on the TEXT, not just the count: a future change could keep the event
    # (because another block carried it) and still smuggle the signature in.
    import json
    from relicpy.shapes.claude import parse
    f = _write(tmp_path, "mixed.jsonl", json.dumps({
        "type": "assistant", "uuid": "u", "sessionId": "s", "cwd": "/r",
        "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "", "signature": SIG},
            {"type": "text", "text": "the visible answer"}]}}) + "\n")
    p = parse(f)
    assert len(p.events) == 1
    assert p.events[0].text == "the visible answer"
    assert not any("CAQS3QY" in e.text for e in p.events)


def test_readable_thinking_is_still_indexed(tmp_path):
    # The inverse control. A fix that dropped ALL thinking would pass the two tests
    # above and silently lose 1.8 MB of real reasoning (9.3% of blocks).
    import json
    from relicpy.shapes.claude import parse
    f = _write(tmp_path, "readable.jsonl", json.dumps({
        "type": "assistant", "uuid": "u", "sessionId": "s", "cwd": "/r",
        "message": {"role": "assistant", "content": [
            {"type": "thinking", "thinking": "reasoning a human can read",
             "signature": SIG}]}}) + "\n")
    p = parse(f)
    assert len(p.events) == 1
    assert p.events[0].text == "reasoning a human can read"


def test_ephemeral_path_tiers():
    from relicpy.ephemeral import ephemeral_hint, ephemeral_note
    # Structural shapes carry their own proof: the pid is IN the path.
    assert ephemeral_hint("wrote /private/tmp/claude-501/-opt-Code/x/out.mp4")["tier"] == "structural"
    assert ephemeral_hint("saved to /Users/b/proj/scratchpad/frames/001.png")["tier"] == "structural"
    # A bare /tmp prefix only correlates — a daemon keeping state there matches too.
    assert ephemeral_hint("config writes to /tmp/daemon.sock")["tier"] == "weak"
    # Prose about temp files is not a path.
    assert ephemeral_hint("we should clean up tmp files someday") is None
    assert ephemeral_hint("the /var/tmpfiles.d unit") is None
    assert ephemeral_hint("/opt/Code/github.com/laris-co/neo-oracle/src/index.ts") is None
    # peer-projects holds 29k files from another account on another box, so a path
    # recorded there cannot be stat'd meaningfully from here — say which bank.
    assert "bank peer-projects" in ephemeral_note("out at /tmp/claude-99/x.bin", "peer-projects")
    assert ephemeral_note("nothing ephemeral here", "peer-projects") == ""


def test_bank_of_hit():
    """A hit has NO `bank` attribute; the bank is the first segment of `repo`. The first
    version of this feature read `getattr(h, "bank", None)`, which returns None and
    drops the host note on EVERY hit — the unit tests could not catch it because they
    pass the bank in directly. The gap was between the tested unit and the caller."""
    from relicpy.ephemeral import bank_of_hit
    assert bank_of_hit("peer-projects/github.com/Arkkra-Co/volt-oracle") == "peer-projects"
    assert bank_of_hit("projects/github.com/laris-co/neo-oracle") == "projects"
    assert bank_of_hit("_unresolved") is None
    assert bank_of_hit("") is None
