"""list_sessions grouping — issue #46.

`relic-py sessions` used to return one row per TRANSCRIPT, disagreeing with the
TypeScript reference (one row per session TREE) by exactly the number of subagent and
workflow_agent children in the corpus. These build a real (in-memory-on-disk) LanceDB
shard via LanceStore so the grouping is exercised through the same code path
`relic-py sessions` actually runs, not just the pure `group_transcripts` helper.
"""

from __future__ import annotations

from relicpy.models import Scope, SessionRow, Shard
from relicpy.query import list_sessions
from relicpy.store import LanceStore


def se(uuid: str, tier: str, started: str, events: float, file_path: str = None) -> SessionRow:
    return SessionRow(session_uuid=uuid, file_path=file_path or f"/x/{uuid}-{tier}.jsonl",
                      repo_key="github.com/a/b", project_dir="p", tier=tier, source="claude",
                      cwd="", model="", worktree="", workflow_run_id="", agent_id="",
                      file_mtime=1.0, file_size=2.0, line_count=1.0, event_count=events,
                      bad_lines=0.0, started_at=started, ended_at=started, description="",
                      title="", git_branch="", imported_at="")


def _shard(tmp_path, name: str, rows: list[SessionRow]) -> tuple[Shard, LanceStore]:
    store = LanceStore.open(str(tmp_path / name))
    store.put_sessions(rows)
    shard = Shard(key=f"projects/github.com/a/b#{name}", dir=str(tmp_path / name),
                  bank="projects", repo="github.com/a/b")
    return shard, store


def test_a_fan_out_with_eleven_children_reports_one_session(tmp_path, monkeypatch):
    rows = [se("u1", "session", "2026-09-01T00:00:00Z", 10)]
    rows += [se("u1", "workflow_agent", f"2026-09-01T00:{i:02d}:00Z", 1,
                file_path=f"/x/u1/agent-{i}.jsonl") for i in range(1, 12)]
    shard, _ = _shard(tmp_path, "one", rows)
    monkeypatch.setattr("relicpy.query.pick_shards", lambda scope: [shard])

    r = list_sessions(Scope())
    assert r["total"] == 1          # sessions (trees)
    assert r["transcripts"] == 12   # files behind them
    assert r["rows"][0]["children"] == 11
    assert r["rows"][0]["tree_events"] == 21


def test_all_tiers_still_shows_every_transcript(tmp_path, monkeypatch):
    rows = [se("u1", "session", "2026-09-01T00:00:00Z", 10)]
    rows += [se("u1", "workflow_agent", f"2026-09-01T00:{i:02d}:00Z", 1,
                file_path=f"/x/u1/agent-{i}.jsonl") for i in range(1, 12)]
    shard, _ = _shard(tmp_path, "two", rows)
    monkeypatch.setattr("relicpy.query.pick_shards", lambda scope: [shard])

    r = list_sessions(Scope(), group=False)
    assert r["total"] == 12         # one row per transcript, grouping disabled
    assert r["transcripts"] == 12
    assert all(x["children"] == 0 for x in r["rows"])
    # Grouped and ungrouped always agree on the total transcript count and the total
    # event count — --all-tiers changes how rows are SHAPED, not what they sum to.
    grouped = list_sessions(Scope())
    assert grouped["transcripts"] == r["transcripts"] == 12
    assert grouped["events"] == r["events"] == 21


def test_two_unrelated_sessions_stay_two_rows(tmp_path, monkeypatch):
    rows = [se("u1", "session", "2026-09-01T00:00:00Z", 5),
           se("u2", "session", "2026-09-02T00:00:00Z", 7)]
    shard, _ = _shard(tmp_path, "three", rows)
    monkeypatch.setattr("relicpy.query.pick_shards", lambda scope: [shard])

    r = list_sessions(Scope())
    assert r["total"] == 2
    assert r["transcripts"] == 2
    assert all(x["children"] == 0 for x in r["rows"])
