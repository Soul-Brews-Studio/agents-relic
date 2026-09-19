"""The host's own session id, from the environment. Mirrors test/session-env.test.ts.

Both hosts publish it and relic read neither, so `relic now` inferred by mtime an answer
that was sitting in a variable — and for Codex the scan cannot reach the session at all,
because codex is the only source with no project-dir layout.
"""

import pytest

from relicpy.live import session_id_from_env

ID = "01a0b746-d27a-7e41-9389-75d59d083fa6"


def test_claude_variable_is_read():
    assert session_id_from_env({"CLAUDE_CODE_SESSION_ID": ID}) == (ID, "CLAUDE_CODE_SESSION_ID")


def test_codex_variable_is_read():
    assert session_id_from_env({"CODEX_THREAD_ID": ID}) == (ID, "CODEX_THREAD_ID")


def test_companion_is_the_last_resort():
    got = session_id_from_env({"CODEX_COMPANION_SESSION_ID": ID})
    assert got and got[1] == "CODEX_COMPANION_SESSION_ID"


def test_claude_wins_when_both_set():
    # Measured in a live process: CLAUDE_CODE_SESSION_ID and CODEX_COMPANION_SESSION_ID
    # held the SAME id. The order must be deterministic regardless.
    got = session_id_from_env({"CODEX_THREAD_ID": "aaaaaaaa-1111", "CLAUDE_CODE_SESSION_ID": ID})
    assert got and got[1] == "CLAUDE_CODE_SESSION_ID"


@pytest.mark.parametrize("v", ["", "   ", "none", "unset", "null", "-", "zzzz"])
def test_junk_never_beats_the_scan(v):
    # These variables are inherited by every child process; a placeholder must not
    # shadow a working filesystem answer with a confident wrong one.
    assert session_id_from_env({"CLAUDE_CODE_SESSION_ID": v}) is None


def test_unset_environment_is_none_not_an_error():
    assert session_id_from_env({}) is None


def test_both_uuid_dialects_parse():
    # Claude writes v4, Codex writes uuidv7 — the shape check must accept both.
    assert session_id_from_env({"CODEX_THREAD_ID": "01a0b746-d27a-7e41-9389-75d59d083fa6"})
    assert session_id_from_env({"CLAUDE_CODE_SESSION_ID": "04d1d650-031a-44f6-9c22-3e400e68390f"})
