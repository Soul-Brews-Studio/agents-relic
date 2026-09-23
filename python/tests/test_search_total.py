"""Issue #95, Python side — "N of M" calls M a count only when it is one.

Mirrors test/search-total.test.ts. Each shard is asked for its own top `limit`, so M
measured the fetch, not the corpus; one real query read "1 of 640" at --limit 1 and
"400 of 53892" at --limit 400. No `limit=0` here: in the port 0 still returns nothing
(#94 was fixed in TypeScript only), so "every match" is a limit past every shard.
"""

from __future__ import annotations

import json
import subprocess
import sys

import pytest

from relicpy.mcp import run
from relicpy.models import EventRow, Scope
from relicpy.query import floor_note, match_count, search_events
from relicpy.repo import shard_dir_for
from relicpy.store import LanceStore


def ev(shard: str, tf: int) -> EventRow:
    # Equal-length docs with a different `needle` count each: no two rows tie.
    return EventRow(uid=f"{shard}{tf}", session_uuid="s1", file_path=f"/x/{shard}.jsonl",
                    repo_key=f"github.com/o/{shard}", seq=float(tf), role="user",
                    ts=f"2026-09-23T00:00:{tf:02d}.000Z",
                    text=" ".join(["needle"] * tf + ["hay"] * (12 - tf)), source="claude",
                    tier="session", kind="transcript", worktree="", cwd="/x", org="o",
                    project="", dir="", mem_type="", origin_session="")


@pytest.fixture(scope="module")
def root(tmp_path_factory):
    r = str(tmp_path_factory.mktemp("total"))
    for shard, tfs in (("a", (10, 8, 6, 4, 2)), ("b", (9, 7, 5, 3, 1))):
        st = LanceStore.open(shard_dir_for(f"github.com/o/{shard}", r))
        st.put_events([ev(shard, tf) for tf in tfs])
        st.ensure_fts_index()
    return r


def search(root: str, limit: int) -> dict:
    return search_events("needle", Scope(data_root=root), limit=limit)


@pytest.mark.parametrize("limit", [5, 6, 50])
def test_read_to_the_end_the_total_is_every_match(root, limit):
    r = search(root, limit)
    assert (r["capped"], r["total"]) == (0, 10)


def test_exactly_limit_matches_is_not_capped(root):
    assert search(root, 5)["capped"] == 0


def test_capped_shards_make_the_total_a_floor(root):
    r = search(root, 2)
    assert r["capped"] == 2 and 2 < r["total"] < 10


def test_the_probe_row_never_changes_what_is_shown(root):
    every = [h.uid for h in search(root, 50)["hits"]]
    assert len(set(every)) == 10
    for limit in (1, 2, 3, 4):
        assert [h.uid for h in search(root, limit)["hits"]] == every[:limit]


def test_the_probe_is_clamped_to_the_native_u32(root):
    # Unclamped, 2^32 raises OverflowError in the binding and every shard answers nothing.
    r = search(root, 2**32 - 1)
    assert (r["total"], r["capped"]) == (10, 0)


def test_the_header_words():
    assert match_count(20, 129) == "20 of 129"
    assert match_count(20, 8620, 488) == "20 of at least 8620"
    assert floor_note(0, 1141, 20) is None
    assert floor_note(488, 1141, 20) == ("a floor, not a count — 488 of 1141 shards hold more than "
                                         "20 matches and were not read to the end")
    assert "more than 1 match and" in floor_note(3, 9, 1)


def cli(root: str, *args: str) -> str:
    return subprocess.run([sys.executable, "-m", "relicpy.cli", "search", "needle", *args,
                           "--data-root", root], capture_output=True, text=True, timeout=300).stdout


def test_both_surfaces_say_it(root, monkeypatch):
    capped = cli(root, "--limit", "2").split("\n")
    assert capped[0].startswith("2 of at least ") and " matches · 2 shards" in capped[0]
    assert capped[1] == ("  a floor, not a count — 2 of 2 shards hold more than 2 matches and were not "
                         "read to the end. Narrow the scope or raise --limit for an exact count.")
    assert cli(root, "--limit", "5").startswith("5 of 10 matches")
    j = json.loads(cli(root, "--limit", "2", "--json"))
    assert (j["exhaustive"], j["capped"]) == (False, 2)
    j = json.loads(cli(root, "--limit", "5", "--json"))
    assert (j["exhaustive"], j["capped"], j["total"]) == (True, 0, 10)

    monkeypatch.setenv("RELIC_DATA_ROOT", root)
    out = run("relic_search", {"query": "needle", "limit": 2}).split("\n")
    assert out[0].startswith("2 of at least ")
    assert out[1].endswith("Pass repo or a higher limit for an exact count.")
    exact = run("relic_search", {"query": "needle", "limit": 5}).split("\n")
    assert exact[0].startswith("5 of 10 matches") and exact[1] == ""
