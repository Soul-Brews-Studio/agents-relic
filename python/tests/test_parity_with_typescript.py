"""The two implementations must agree about the same index.

This is the test the port exists to pass. Schema parity (test_schema_matches_disk)
proves the Python models describe the same columns; this proves the Python QUERIES
return the same answers as the reference implementation, over the same files.

Skipped, not failed, when bun or the index is absent — on a machine with neither,
"the implementations disagree" would be an untrue thing to report.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess

import pytest

from relicpy.models import Scope
from relicpy.query import index_status

TS_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _ts_status() -> dict:
    if not shutil.which("bun"):
        pytest.skip("bun not installed — cannot run the reference implementation")
    cli = os.path.join(TS_REPO, "src", "cli.ts")
    if not os.path.isfile(cli):
        pytest.skip(f"reference CLI not found at {cli}")
    out = subprocess.run(["bun", cli, "status", "--json"], cwd=TS_REPO,
                         capture_output=True, text=True, timeout=300)
    if out.returncode != 0:
        pytest.skip(f"reference CLI failed: {out.stderr[:200]}")
    return json.loads(out.stdout)


@pytest.fixture(scope="module")
def both():
    ts = _ts_status()
    if not ts.get("rows"):
        pytest.skip("no shards indexed on this machine")
    _, py = index_status(Scope(), freshness=False)
    return ts, py


def test_same_shard_count(both):
    ts, py = both
    assert len(py) == ts["shards"]


def test_same_event_total(both):
    ts, py = both
    assert sum(r.events for r in py) == ts["events"]


def test_same_session_total(both):
    ts, py = both
    assert sum(r.sessions for r in py) == ts["sessions"]


def test_same_shard_keys(both):
    """Not just the same COUNT — the same shards.

    Two implementations can agree on 508 while disagreeing about which 508, if one
    walks a directory level the other misses.
    """
    ts, py = both
    assert {r.key for r in py} == {r["key"] for r in ts["rows"]}


def test_same_counts_per_shard(both):
    ts, py = both
    ts_by = {r["key"]: (r["events"], r["sessions"]) for r in ts["rows"]}
    py_by = {r.key: (r.events, r.sessions) for r in py}
    mismatched = {k: (ts_by[k], py_by[k]) for k in ts_by if ts_by[k] != py_by.get(k)}
    assert not mismatched, f"per-shard disagreement: {list(mismatched.items())[:5]}"
