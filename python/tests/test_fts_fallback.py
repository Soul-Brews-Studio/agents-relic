"""Issue #63, Python side: ICU first, `simple` only on a build without ICU, recorded by index name."""

from __future__ import annotations

import os
import tempfile
import warnings

import pytest

from relicpy.store import SIMPLE_INDEX, LanceStore, _create_fts

REFUSAL = "lance error: Invalid user input: unknown base tokenizer icu"


def no_icu(t, tokenizer, name):
    if tokenizer == "icu":
        raise RuntimeError(REFUSAL)
    _create_fts(t, tokenizer, name)


def _has_icu() -> bool:
    """#104: probed once, through the production path. It answers `simple` only on the
    "unknown base tokenizer" refusal and raises on anything else, so a real failure
    cannot pass for a missing ICU."""
    with tempfile.TemporaryDirectory() as d:
        st = LanceStore.open(d)
        st.db.create_table("events", data=[{"uid": "a", "text": "hello world"}])
        return st.ensure_fts_index()["tokenizer"] == "icu"


# The tests that need a REAL ICU cannot pass on a build without one (macOS x86_64).
# RELIC_REQUIRE_ICU=1 runs them anyway, so a host that should have ICU fails.
HAS_ICU = _has_icu()
REQUIRE_ICU = os.environ.get("RELIC_REQUIRE_ICU") == "1"
if not HAS_ICU:
    warnings.warn("this LanceDB build has no ICU (#104) — " +
                  ("RELIC_REQUIRE_ICU=1, so the ICU tests run and fail" if REQUIRE_ICU
                   else "the ICU tests are skipped; RELIC_REQUIRE_ICU=1 fails them instead"))
icu_only = pytest.mark.skipif(not HAS_ICU and not REQUIRE_ICU,
                              reason="this LanceDB build has no ICU (#104)")


@pytest.fixture
def store(tmp_path):
    st = LanceStore.open(str(tmp_path))
    st.db.create_table("events", data=[{"uid": "a", "text": "Air4Thai sensor ความ"},
                                       {"uid": "b", "text": "hello world"}])
    return st


def names(st):
    return sorted(i.name for i in st._existing("events").list_indices())


@icu_only
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


@icu_only
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
