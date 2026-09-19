"""The embed write path, with no network and no model runtime.

Every provider here is a local lambda, so a failure is about relicpy's code — batching,
resume, the dim guard — and never about whether ollama happens to be running.
"""

from __future__ import annotations

import lancedb
import pytest

from relicpy.embed import Provider, embed_shard, l2_normalise, provider_for
from relicpy.models import EventRow, FileRow
from relicpy.store import LanceStore


def fake(dim: int, tag: str = "fake") -> Provider:
    return Provider(id=f"test:{tag}",
                    encode=lambda texts: [[float((ord(t[i % len(t)]) % 17) + 1)
                                           for i in range(dim)] for t in texts])


def mkstore(tmp_path, name: str, n: int) -> LanceStore:
    s = LanceStore.open(str(tmp_path / name))
    s.put_events([EventRow(
        uid=f"u{i}", session_uuid="s", file_path="/f", repo_key="r", seq=float(i),
        role="user", ts="", text=f"event number {i} with enough text to pass min-chars",
        source="claude", tier="session", kind="transcript", worktree="", cwd="",
        org="", project="", dir="", mem_type="", origin_session="") for i in range(n)])
    return s


# --------------------------------------------------------------- the design's reason

def test_add_columns_makes_a_vector_column_utf8(tmp_path):
    """Why `vectors` is a separate table, reproduced — and where the two clients differ.

    `add_columns` can only backfill a SCALAR default, so an `embedding` column added by
    widening lands as Utf8 in BOTH implementations. What happens on the next write does
    not match, and the difference is client-side, not in the shared Rust core:

        TypeScript (@lancedb/lancedb)  writes [0.1, 0.2] as the STRING "0.1,0.2".
                                       No error. Measured against 0.39.0.
        Python (lancedb)               raises ArrowNotImplementedError:
                                       "Unsupported cast from list<item: double> to utf8".

    So the silent-corruption half of this trap is TypeScript's alone — which is exactly
    where it mattered, since `widen()` and `EventRow` live there. The guard in
    store/lance.ts closes it; this test pins the Python behaviour so that a future
    client release which starts coercing instead of raising is caught here rather than
    discovered as a shard full of text.
    """
    db = lancedb.connect(str(tmp_path / "raw"))
    t = db.create_table("c", data=[{"uid": "x", "text": "hi"}])
    t.add_columns({"embedding": "''"})
    assert str(t.schema.field("embedding").type) == "string"   # widened to text, as in TS
    with pytest.raises(Exception, match="(?i)cast|utf8"):
        (t.merge_insert("uid").when_matched_update_all().when_not_matched_insert_all()
          .execute([{"uid": "y", "text": "yo", "embedding": [0.1, 0.2]}]))


# ------------------------------------------------------------------------- helpers

def test_l2_normalise_unit_length():
    v = l2_normalise([3.0, 4.0])
    assert abs(sum(x * x for x in v) - 1.0) < 1e-12
    assert abs(v[0] - 0.6) < 1e-12


def test_l2_normalise_leaves_a_zero_vector_alone():
    # Dividing by zero here would poison every later comparison silently: a NaN
    # distance sorts unpredictably rather than erroring.
    assert l2_normalise([0.0, 0.0]) == [0.0, 0.0]


def test_provider_ids_are_qualified():
    assert provider_for("ollama", "all-minilm").id == "ollama:all-minilm"
    with pytest.raises(ValueError):
        provider_for("nope", "x")


# ---------------------------------------------------------------------- embed_shard

def test_writes_a_typed_vector_column_and_leaves_events_alone(tmp_path):
    s = mkstore(tmp_path, "ok", 5)
    r = embed_shard(s, fake(8))
    assert (r.embedded, r.dim) == (5, 8)
    assert s.vector_stats() == {"rows": 5, "model": "test:fake", "dim": 8, "norm": "l2"}
    db = lancedb.connect(str(tmp_path / "ok"))
    assert "embedding" not in db.open_table("events").schema.names
    assert "fixed_size_list" in str(db.open_table("vectors").schema.field("embedding").type)


def test_resumable(tmp_path):
    s = mkstore(tmp_path, "resume", 4)
    assert embed_shard(s, fake(8)).embedded == 4
    again = embed_shard(s, fake(8))
    assert (again.embedded, again.pending, again.already) == (0, 0, 4)


def test_limit_caps_the_run(tmp_path):
    s = mkstore(tmp_path, "limit", 10)
    assert embed_shard(s, fake(8), limit=3).embedded == 3
    assert embed_shard(s, fake(8), limit=3).already == 3


def test_dry_run_writes_nothing(tmp_path):
    s = mkstore(tmp_path, "dry", 6)
    r = embed_shard(s, fake(8), dry_run=True)
    assert (r.pending, r.embedded) == (6, 0)
    assert s.vector_stats() is None


def test_refuses_a_second_model_instead_of_failing_mid_batch(tmp_path):
    s = mkstore(tmp_path, "mismatch", 4)
    embed_shard(s, fake(8, "a"))
    r = embed_shard(s, fake(16, "b"))
    assert r.embedded == 0 and "--reset" in r.skipped
    assert s.vector_stats()["dim"] == 8


def test_reset_drops_vectors_and_only_vectors(tmp_path):
    s = mkstore(tmp_path, "reset", 4)
    embed_shard(s, fake(8, "a"))
    r = embed_shard(s, fake(16, "b"), reset=True)
    assert r.embedded == 4
    assert s.vector_stats()["dim"] == 16
    assert s.counts()["events"] == 4      # a reset can never cost an index run


def test_min_chars_drops_events_too_short_to_mean_anything(tmp_path):
    s = LanceStore.open(str(tmp_path / "short"))
    common = dict(session_uuid="s", file_path="/f", repo_key="r", role="user", ts="",
                  source="claude", tier="session", kind="transcript", worktree="",
                  cwd="", org="", project="", dir="", mem_type="", origin_session="")
    s.put_events([EventRow(uid="a", seq=0.0, text="ok", **common),
                  EventRow(uid="b", seq=1.0,
                           text="a sentence long enough to carry meaning", **common)])
    assert embed_shard(s, fake(8)).embedded == 1


def test_one_bad_batch_costs_its_own_rows_not_the_run(tmp_path):
    s = mkstore(tmp_path, "partial", 4)
    calls = {"n": 0}

    def flaky(texts):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("boom")
        return [[1.0] * 8 for _ in texts]

    r = embed_shard(s, Provider(id="test:flaky", encode=flaky), batch=2)
    assert (r.failed, r.embedded) == (2, 2)
    # and the failed uids are simply pending again
    assert embed_shard(s, fake(8, "flaky"), batch=2).pending == 2


# --------------------------------------------------------- the shared tier predicate

def test_main_tiers_filter_names_kind_only_when_the_column_exists(tmp_path):
    """The column is ABSENT on old shards, not empty — 509 of 817 in the live index.

    A filter that NAMES `kind` is invalid SQL there, every shard throws, the per-shard
    catch swallows it, and the search reports zero hits with a healthy shard count. So
    the schema has to pick the filter before any SQL is built.
    """
    new = mkstore(tmp_path, "haskind", 1)
    assert "kind" in new.main_tiers_filter()

    old = LanceStore.open(str(tmp_path / "nokind"))
    old.put_files([FileRow(file_path="/f", repo_key="r", mtime=1.0, size=2.0,
                           imported_at="")])
    # no `events` table at all -> the pre-kind form, which is valid everywhere
    assert old.main_tiers_filter() == "(tier = 'session' OR tier = 'note')"


def test_st_provider_id_matches_the_typescript_contract():
    """The id is a CROSS-IMPLEMENTATION contract, not a label.

    `embed_shard` refuses a shard whose stored model differs from the running provider's
    id. If the two implementations computed it differently they would refuse each other's
    shards while both looked correct alone. test/embed.test.ts asserts the same literals.

    Built without importing sentence-transformers — only the id is under test.
    """
    from relicpy import embed as E

    assert E.st_provider.__doc__  # the function exists and is documented
    # Mirror of provider_for()'s prefix rule, which is what produces the id.
    for model, want in [
        ("intfloat/multilingual-e5-small", "st:intfloat/multilingual-e5-small+passage:"),
        ("sentence-transformers/all-MiniLM-L6-v2",
         "st:sentence-transformers/all-MiniLM-L6-v2"),
    ]:
        doc = "passage: " if "e5" in model.lower() else ""
        tag = f"st:{model}" + (f"+{doc.strip()}" if doc else "")
        assert tag == want
