"""Issue #63, Python side: ICU first, `simple` only on a build without ICU, recorded by index name."""

from __future__ import annotations

import pytest

from relicpy.store import SIMPLE_INDEX, LanceStore, _create_fts

REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu"


def no_icu(t, tokenizer, name):
    if tokenizer == "icu":
        raise RuntimeError(REFUSAL)
    _create_fts(t, tokenizer, name)


@pytest.fixture
def store(tmp_path):
    st = LanceStore.open(str(tmp_path))
    st.db.create_table("events", data=[{"uid": "a", "text": "Air4Thai sensor ความ"},
                                       {"uid": "b", "text": "hello world"}])
    return st


def names(st):
    return sorted(i.name for i in st._existing("events").list_indices())


def test_icu_available(store):
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": True, "upgraded": False}
    assert store.fts_tokenizer() == "icu"


def test_icu_refused_builds_simple_under_a_recording_name(store):
    r = store.ensure_fts_index(create=no_icu)
    assert r["tokenizer"] == "simple" and r["built"] and "unknown base tokenizer" in r["fell_back"]
    assert names(store) == [SIMPLE_INDEX]
    assert store.fts_tokenizer() == "simple"


def test_still_refused_keeps_the_fallback(store):
    store.ensure_fts_index(create=no_icu)
    assert store.ensure_fts_index(create=no_icu)["built"] is False
    assert names(store) == [SIMPLE_INDEX]


def test_later_run_with_icu_upgrades(store):
    store.ensure_fts_index(create=no_icu)
    assert store.ensure_fts_index() == {"tokenizer": "icu", "built": True, "upgraded": True}
    assert SIMPLE_INDEX not in names(store)
    assert store.fts_tokenizer() == "icu"


def test_other_failures_still_raise(store):
    def broken(t, tokenizer, name):
        raise RuntimeError("disk full")
    with pytest.raises(RuntimeError, match="disk full"):
        store.ensure_fts_index(create=broken)
