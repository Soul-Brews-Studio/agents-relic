"""Issue #71 — with no FTS index, search falls back to a LIKE scan that must match
regardless of case, like the FTS path it stands in for. Mirrors test/like-fallback.test.ts."""

from __future__ import annotations

from relicpy.models import EventRow
from relicpy.store import LanceStore


def ev(uid: str, text: str) -> EventRow:
    return EventRow(uid=uid, session_uuid="s", file_path="/a.jsonl", repo_key="r", seq=1.0,
                    role="user", ts="", text=text, source="claude", tier="session",
                    kind="transcript", worktree="", cwd="", org="", project="", dir="",
                    mem_type="", origin_session="")


def test_like_fallback_ignores_case(tmp_path):
    s = LanceStore.open(str(tmp_path / "case"))
    s.put_events([ev("u1", "deploy Air4Thai sensors"), ev("u2", "unrelated")])
    for q in ("air4thai", "Air4Thai", "AIR4THAI"):
        assert [h["uid"] for h in s.search(q)] == ["u1"]


def test_like_fallback_still_escapes_quotes(tmp_path):
    s = LanceStore.open(str(tmp_path / "quote"))
    s.put_events([ev("u1", "Nat's board"), ev("u2", "boards")])
    assert [h["uid"] for h in s.search("NAT'S")] == ["u1"]
