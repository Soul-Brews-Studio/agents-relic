"""Issue #59 — the same window in three spellings must select the same sessions,
and a session running through the window is in it. Mirrors test/window.test.ts."""

from __future__ import annotations

import time

import pytest

from relicpy.models import Scope, SessionRow, Shard
from relicpy.query import list_sessions, to_iso
from relicpy.store import LanceStore


@pytest.fixture
def bangkok(monkeypatch):
    monkeypatch.setenv("TZ", "Asia/Bangkok")
    time.tzset()
    yield
    monkeypatch.undo()
    time.tzset()


def row(uuid: str, tier: str, started: str, ended: str, file_path: str | None = None) -> SessionRow:
    return SessionRow(session_uuid=uuid, file_path=file_path or f"/x/{uuid}-{tier}.jsonl",
                      repo_key="github.com/a/b", project_dir="p", tier=tier, source="claude",
                      cwd="", model="", worktree="", workflow_run_id="", agent_id="",
                      file_mtime=1.0, file_size=2.0, line_count=1.0, event_count=5.0,
                      bad_lines=0.0, started_at=started, ended_at=ended, description="d",
                      title="", git_branch="", imported_at="")


def test_three_spellings_of_one_instant_normalise_alike(bangkok):
    want = "2026-09-21T22:00:00.000Z"
    assert to_iso("2026-09-22T05:00") == want
    assert to_iso("2026-09-22T05:00:00+07:00") == want
    assert to_iso("2026-09-21T22:00:00Z") == want


def test_bare_dates_and_garbage_keep_their_meaning(bangkok):
    assert to_iso("2026-09-01") == "2026-09-01"
    assert to_iso("not-a-dateTx") == "not-a-dateTx"


def test_window_rows_match_across_spellings_and_include_spanning_sessions(tmp_path, monkeypatch, bangkok):
    store = LanceStore.open(str(tmp_path / "s"))
    store.put_sessions([
        row("aaaa", "session", "2026-09-21T22:29:00.000Z", "2026-09-21T22:40:00.000Z"),
        row("bbbb", "session", "2026-09-21T22:30:00.000Z", "2026-09-22T06:15:00.000Z"),
        row("bbbb", "workflow_agent", "2026-09-22T05:05:00.000Z", "2026-09-22T05:30:00.000Z",
            file_path="/x/bbbb/wf/agent-1.jsonl"),
        row("cccc", "session", "2026-09-21T20:00:00.000Z", "2026-09-21T21:00:00.000Z"),
    ])
    shard = Shard(key="projects/github.com/a/b", dir=str(tmp_path / "s"), bank="projects", repo="github.com/a/b")
    monkeypatch.setattr("relicpy.query.pick_shards", lambda scope: [shard])

    def ids(since: str, until: str) -> list[str]:
        return sorted(r["session_uuid"] for r in list_sessions(Scope(), since=since, until=until)["rows"])

    bare = ids("2026-09-22T05:00", "2026-09-22T06:00")
    assert bare == ["aaaa", "bbbb"]
    assert ids("2026-09-22T05:00:00+07:00", "2026-09-22T06:00:00+07:00") == bare
    assert ids("2026-09-21T22:00:00Z", "2026-09-21T23:00:00Z") == bare
    assert ids("2026-09-22T07:00", "2026-09-22T08:00") == ["bbbb"]
