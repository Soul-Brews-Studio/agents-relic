"""Issue #97, Python side: every word reaches the index, and an index built before that is rebuilt."""

from __future__ import annotations

import os
import tempfile

import pytest
from lancedb.index import FTS

from relicpy.store import SIMPLE_INDEX, LanceStore, _create_fts, _drifted

REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu"


def no_icu(t, tokenizer, name):
    if tokenizer == "icu":
        raise RuntimeError(REFUSAL)
    _create_fts(t, tokenizer, name)


def before(tokenizer):
    """Every shard src/store/fts.ts built before #97: LanceDB's stop-word default."""
    return FTS(base_tokenizer=tokenizer, stem=False, remove_stop_words=True, max_token_length=128)


def _has_icu() -> bool:
    """#104's probe: the production path, so only the "unknown base tokenizer" refusal reads as no ICU."""
    with tempfile.TemporaryDirectory() as d:
        st = LanceStore.open(d)
        st.db.create_table("events", data=[{"uid": "a", "text": "hello world"}])
        return st.ensure_fts_index()["tokenizer"] == "icu"


icu_only = pytest.mark.skipif(not _has_icu() and os.environ.get("RELIC_REQUIRE_ICU") != "1",
                              reason="this LanceDB build has no ICU (#104)")


@pytest.fixture
def store(tmp_path):
    st = LanceStore.open(str(tmp_path))
    st.db.create_table("events", data=[{"uid": "a", "text": "All 15 files backed up to odin NAS."},
                                       {"uid": "b", "text": "bin min var dir — is it not"}])
    return st


def hits(st, q):
    return len(st._existing("events").search(q, query_type="fts").limit(10).to_list())


def names(st):
    return sorted(i.name for i in st._existing("events").list_indices())


@icu_only
def test_icu_keeps_nas_bin_and_min(store):
    assert store.ensure_fts_index()["tokenizer"] == "icu"
    assert {q: hits(store, q) for q in ("nas", "NAS", "bin", "min", "is", "not")} == \
        {"nas": 1, "NAS": 1, "bin": 1, "min": 1, "is": 1, "not": 1}


def test_simple_keeps_them_too(store):
    assert store.ensure_fts_index(create=no_icu)["tokenizer"] == "simple"
    assert {q: hits(store, q) for q in ("nas", "bin", "is", "not")} == {"nas": 1, "bin": 1, "is": 1, "not": 1}


@icu_only
def test_stale_icu_index_is_rebuilt_then_left_alone(store):
    store._existing("events").create_index("text", config=before("icu"))
    assert hits(store, "nas") == 0
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": True, "upgraded": False, "drifted": True}
    assert hits(store, "nas") == 1
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": False}


def test_stale_simple_index_is_rebuilt_while_icu_is_refused(store):
    store._existing("events").create_index("text", config=before("simple"), name=SIMPLE_INDEX)
    assert hits(store, "is") == 0
    r = store.ensure_fts_index(create=no_icu)
    assert r["tokenizer"] == "simple" and r["built"] and r["drifted"]
    assert hits(store, "is") == 1
    assert store.ensure_fts_index(create=no_icu)["built"] is False


@icu_only
def test_never_icu_to_simple(store):
    store._existing("events").create_index("text", config=before("icu"))
    for rebuild in (False, True):
        r = store.ensure_fts_index(rebuild=rebuild, create=no_icu)
        assert r["tokenizer"] == "icu" and r["built"] is False and "unknown base tokenizer" in r["fell_back"]
        assert names(store) == ["text_idx"]


def test_no_details_is_unknown_not_drift():
    assert [_drifted(d) for d in (None, {}, {"remove_stop_words": None}, {"remove_stop_words": False})] == \
        [False, False, False, False]
    assert _drifted({"remove_stop_words": True}) is True
