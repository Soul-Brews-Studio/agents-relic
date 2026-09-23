"""Issue #115, Python side: an index that no longer covers its shard is rebuilt, and status says so."""

from __future__ import annotations

import math
import os
import tempfile
from types import SimpleNamespace

import pytest

from relicpy.store import (COVER_FRACTION, COVER_MIN_ROWS, SIMPLE_INDEX, LanceStore, _behind, _create_fts)

REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu"


def no_icu(t, tokenizer, name):
    if tokenizer == "icu":
        raise RuntimeError(REFUSAL)
    _create_fts(t, tokenizer, name)


def _has_icu() -> bool:
    """#104's probe: the production path, so only the "unknown base tokenizer" refusal reads as no ICU."""
    with tempfile.TemporaryDirectory() as d:
        st = LanceStore.open(d)
        st.db.create_table("events", data=[{"uid": "a", "text": "hello world"}])
        return st.ensure_fts_index()["tokenizer"] == "icu"


icu_only = pytest.mark.skipif(not _has_icu() and os.environ.get("RELIC_REQUIRE_ICU") != "1",
                              reason="this LanceDB build has no ICU (#104)")

BASE = 2_000
# Past the threshold whatever it is: the floor AND the fraction of the grown shard.
ENOUGH = max(COVER_MIN_ROWS, math.ceil(BASE * COVER_FRACTION / (1 - COVER_FRACTION)) + 1)


def rows(n, start=0):
    return [{"uid": f"r{start + i}", "text": f"row {start + i} backed up to odin NAS"} for i in range(n)]


@pytest.fixture
def store(tmp_path):
    st = LanceStore.open(str(tmp_path))
    st.db.create_table("events", data=rows(BASE))
    return st


def test_behind_needs_the_floor_and_the_fraction():
    def info(gap, indexed):
        return SimpleNamespace(num_unindexed_rows=gap, num_indexed_rows=indexed)
    assert not _behind(None) and not _behind(SimpleNamespace()) and not _behind(info(0, 10))
    assert _behind(info(COVER_MIN_ROWS, 0))
    big = math.ceil(COVER_MIN_ROWS / COVER_FRACTION) * 10
    assert not _behind(info(math.floor(big * COVER_FRACTION) - 1, big))
    assert _behind(info(math.ceil(big * COVER_FRACTION / (1 - COVER_FRACTION)) + 1, big))


@icu_only
def test_gap_past_the_threshold_is_covered(store):
    store.ensure_fts_index()
    store._existing("events").add(rows(ENOUGH, BASE))
    assert store.fts_unindexed() == ENOUGH
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": True, "upgraded": False, "covered": ENOUGH}
    assert store.fts_unindexed() == 0
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": False}


def test_simple_gap_is_covered_while_icu_is_refused(store):
    store.ensure_fts_index(create=no_icu)
    store._existing("events").add(rows(ENOUGH, BASE))
    r = store.ensure_fts_index(create=no_icu)
    assert r["tokenizer"] == "simple" and r["built"] and r["covered"] == ENOUGH
    assert store.fts_unindexed() == 0
    assert [i.name for i in store._existing("events").list_indices()] == [SIMPLE_INDEX]


def test_a_gap_below_the_threshold_stays_and_is_reported(store):
    store.ensure_fts_index(create=no_icu)
    small = max(1, COVER_MIN_ROWS // 2)
    store._existing("events").add(rows(small, BASE))
    assert store.ensure_fts_index(create=no_icu)["built"] is False
    assert store.fts_unindexed() == small
