"""#99: a walker that cannot read a directory must say so. Mirrors test/unreadable.test.ts.

Every walker answered a failed scandir or stat with an empty list, so an unreadable
directory looked exactly like an empty one — `relic pending` said "0 missing" about
files it had never been able to see. chmod 000 is the whole fixture, and root ignores
it, so those tests skip under root.
"""

import json
import os
import subprocess
import sys

import pytest

from relicpy import discover as D
from relicpy import sources as S
from relicpy import unreadable as U
from relicpy.noise import log_skipped, read_skipped, read_skipped_files
from relicpy.prune import prune_refusal
from relicpy.shapes import claude as shape_claude

A = "aaaaaaaa-1111-4000-8000-000000000000"
B = "bbbbbbbb-2222-4000-8000-000000000000"
as_root = pytest.mark.skipif(hasattr(os, "geteuid") and os.geteuid() == 0,
                             reason="root reads a chmod 000 directory anyway")


def _put(path, sid=A):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as fh:
        fh.write(json.dumps({"type": "user", "sessionId": sid, "uuid": f"{sid}-1",
                             "timestamp": "2026-09-23T01:00:00.000Z", "cwd": "/work/repo",
                             "message": {"role": "user", "content": "hi"}}) + "\n")


@pytest.fixture
def lock():
    """chmod 000, and put it back afterwards so the temp dir can be removed."""
    held = []

    def _lock(p):
        os.chmod(p, 0)
        held.append(p)
    yield _lock
    for p in held:
        os.chmod(p, 0o755)


def _walk(home, capsys):
    out = []
    U.begin_walk()
    D._walk_claude_home(str(home), None, out, "k", shape_claude.parse)
    said = [l for l in capsys.readouterr().err.splitlines() if l.startswith("relic:")]
    return sorted(f.path for f in out), said


@as_root
def test_an_unreadable_project_dir_warns_once_and_yields_nothing(tmp_path, capsys, lock):
    projects = tmp_path / "projects"
    _put(str(projects / "-work-ok" / f"{A}.jsonl"))
    bad = projects / "-work-locked"
    _put(str(bad / f"{B}.jsonl"), B)
    _put(str(bad / B / "subagents" / "agent-a1.jsonl"), B)
    lock(bad)

    found, said = _walk(tmp_path, capsys)
    assert found == [str(projects / "-work-ok" / f"{A}.jsonl")]
    # _files, the subagents probe and _dirs all hit it — one line, not three.
    assert len(said) == 1, said
    assert str(bad) in said[0] and "EACCES" in said[0]
    assert [(x["rule"], x["path"]) for x in U.walk_failures()] == [("dir-unreadable", str(bad))]


@as_root
def test_a_session_dir_without_search_permission_is_reported(tmp_path, capsys, lock):
    proj = tmp_path / "projects" / "-work-sess"
    _put(str(proj / f"{A}.jsonl"))
    _put(str(proj / A / "subagents" / "agent-a1.jsonl"))
    lock(proj / A)

    found, said = _walk(tmp_path, capsys)
    assert found == [str(proj / f"{A}.jsonl")]
    assert len(said) == 1, said
    assert str(proj / A / "subagents") in said[0]


@as_root
def test_a_second_walk_is_quiet_on_stderr_but_still_counts_it(tmp_path, capsys, lock):
    bad = tmp_path / "projects" / "-work-locked"
    bad.mkdir(parents=True)
    lock(bad)
    assert len(_walk(tmp_path, capsys)[1]) == 1
    assert _walk(tmp_path, capsys)[1] == []
    assert [x["path"] for x in U.walk_failures()] == [str(bad)]


def test_a_missing_dir_produces_no_warning(tmp_path, capsys):
    projects = tmp_path / "projects"
    _put(str(projects / "-work-a" / f"{A}.jsonl"))
    _put(str(projects / "-work-b" / B / "subagents" / "agent-b1.jsonl"), B)
    (projects / "-work-c" / A).mkdir(parents=True)

    found, said = _walk(tmp_path, capsys)
    assert len(found) == 2                          # the -work-a session, the -work-b subagent
    assert said == []
    assert U.walk_failures() == []
    assert not U.reachable(str(tmp_path / "no-such-root"))
    assert capsys.readouterr().err == ""


def test_a_broken_sources_json_prints_the_parse_error_once(tmp_path, capsys, monkeypatch):
    cfg = tmp_path / ".relic" / "sources.json"
    cfg.parent.mkdir()
    cfg.write_text('{ "enable": ["hermes"], }')
    monkeypatch.setattr(S, "HOME", str(tmp_path))
    monkeypatch.setattr(S, "_config_warned", set())

    S.load_sources()
    keys = {s.key: s.enabled for s in S.load_sources()}
    said = [l for l in capsys.readouterr().err.splitlines() if "sources.json" in l]
    assert len(said) == 1, said                     # two loads, one line
    assert str(cfg) in said[0] and "JSONDecodeError" in said[0]
    assert "built-in sources only" in said[0]
    assert "claude-live" in keys and keys["hermes"] is False


def test_a_bad_entry_names_its_section_and_keeps_what_came_before(tmp_path, capsys, monkeypatch):
    cfg = tmp_path / ".relic" / "sources.json"
    cfg.parent.mkdir()
    cfg.write_text(json.dumps({"enable": ["hermes"], "homes": [None]}))
    monkeypatch.setattr(S, "HOME", str(tmp_path))
    monkeypatch.setattr(S, "_config_warned", set())

    keys = {s.key: s.enabled for s in S.load_sources()}
    err = capsys.readouterr().err
    assert 'bad "homes" entry' in err and "partly applied" in err
    assert keys["hermes"] is True                   # `enable` ran before `homes` threw


def test_corpus_hermes_says_it_is_not_supported(tmp_path):
    env = {k: v for k, v in os.environ.items()
           if k not in ("CLAUDE_CONFIG_DIR", "CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID")}
    env["HOME"] = str(tmp_path)
    p = subprocess.run([sys.executable, "-m", "relicpy.cli", "index", "--corpus", "hermes",
                        "--dry-run"], capture_output=True, text=True, env=env, timeout=120)
    assert p.returncode == 0, p.stderr
    assert "hermes" in p.stderr and "not supported by relic-py yet" in p.stderr


def test_prune_is_refused_after_a_walk_that_could_not_read_everything():
    class T:
        failed = 0
    assert "2 paths could not be read" in prune_refusal(T(), None, None, unreadable=2)
    assert prune_refusal(T(), None, None, unreadable=0) is None
    assert prune_refusal(T(), None, None) is None


def test_the_proof_log_keeps_paths_apart_from_events(tmp_path):
    root = str(tmp_path)
    log_skipped([{"uid": "u1", "file_path": "/x/a.jsonl", "seq": 3, "role": "tool_result",
                  "rule": "binary-blob", "bytes": 500, "head": "AAAA"}], root)

    def row(path, ts, rule="dir-unreadable"):
        return {"rule": rule, "path": path, "error": "EACCES: Permission denied", "ts": ts}
    log_skipped([row("/r/-locked", "2026-09-22T01:00:00.000Z"),
                 row("/r/-x/s.jsonl", "2026-09-22T01:00:00.000Z", "walk-error")], root)
    log_skipped([row("/r/-locked", "2026-09-23T01:00:00.000Z")], root)

    ev = read_skipped(root)
    assert ev["total"] == 1 and [b["rule"] for b in ev["by_rule"]] == ["binary-blob"]
    fs = read_skipped_files(root)
    assert fs["total"] == 2
    top = fs["paths"][0]
    assert top["path"] == "/r/-locked" and top["runs"] == 2 and top["ts"].startswith("2026-09-23")
