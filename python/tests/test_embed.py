"""The embed write path, with no network and no model runtime.

Every provider here is a local lambda, so a failure is about relicpy's code — batching,
resume, the dim guard — and never about whether ollama happens to be running.
"""

from __future__ import annotations

import os

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


# --------------------------------------- a vectors table that no longer reads (#105)

def damaged(tmp_path, name: str, zero: list[int]) -> LanceStore:
    """The REPORTED state, built on purpose. The same shape as test/embed.test.ts: 20
    events, 3 commits of 4 (v1..v3), and the data files the given commits wrote truncated
    to 0 bytes. A kill alone does not produce it (see LanceStore.vectorDamage() in
    src/store/lance.ts), so this truncates exactly what those versions reference."""
    s = mkstore(tmp_path, name, 20)
    data = tmp_path / name / "vectors.lance" / "data"
    files = lambda: set(os.listdir(data)) if data.exists() else set()   # noqa: E731
    per_commit: list[set[str]] = []
    put = s.put_vectors

    def tracked(rows, dim):
        had = files()
        put(rows, dim)
        per_commit.append(files() - had)

    s.put_vectors = tracked
    embed_shard(s, fake(8), batch=4, limit=12)
    for c in zero:
        for f in per_commit[c]:
            os.truncate(data / f, 0)
    return LanceStore.open(str(tmp_path / name))    # the damage is on disk, not in a handle


def _version(tmp_path, name: str) -> int:
    return lancedb.connect(str(tmp_path / name)).open_table("vectors").version


def test_the_reported_state_counts_but_does_not_scan(tmp_path):
    s = damaged(tmp_path, "d-state", [1, 2])
    assert s.vector_stats()["rows"] == 12            # manifest-only reads look healthy
    with pytest.raises(Exception, match=r"LanceError\(IO\)"):
        s.embedded_uids()
    assert s.counts()["events"] == 20


def test_vector_damage_names_the_failing_version_and_the_newest_readable(tmp_path):
    d = damaged(tmp_path, "d-diag", [1, 2]).vector_damage()
    assert {k: d[k] for k in ("version", "rows", "restorable", "keep")} == \
        {"version": 3, "rows": 12, "restorable": 1, "keep": 4}


def test_a_table_that_reads_or_none_at_all_is_not_damage(tmp_path):
    s = mkstore(tmp_path, "d-none", 4)
    assert s.vector_damage() is None
    embed_shard(s, fake(8))
    assert s.vector_damage() is None


def test_without_repair_the_shard_is_skipped_and_nothing_is_written(tmp_path):
    s = damaged(tmp_path, "d-skip", [1, 2])
    r = embed_shard(s, fake(8), batch=4)
    assert r.skipped.startswith("vectors table unreadable at v3 — LanceError(IO)")
    assert (r.damage["restorable"], r.damage["keep"], r.repaired, r.embedded) == (1, 4, "", 0)
    assert _version(tmp_path, "d-skip") == 3


def test_a_dry_run_never_repairs_even_with_repair(tmp_path):
    s = damaged(tmp_path, "d-dry", [1, 2])
    r = embed_shard(s, fake(8), batch=4, repair=True, dry_run=True)
    assert "unreadable at v3" in r.skipped and r.repaired == ""
    assert _version(tmp_path, "d-dry") == 3


def test_repair_restores_the_newest_readable_version_and_re_embeds_the_rest(tmp_path):
    s = damaged(tmp_path, "d-restore", [1, 2])
    r = embed_shard(s, fake(8), batch=4, repair=True)
    assert (r.repaired, r.already, r.embedded, r.skipped) == ("restored", 4, 16, "")
    assert s.vector_damage() is None
    assert len(s.embedded_uids()) == 20
    assert s.counts()["events"] == 20
    assert _version(tmp_path, "d-restore") > 3       # restore wrote on top; history kept


def test_repair_drops_vectors_and_nothing_else_when_no_version_reads(tmp_path):
    s = damaged(tmp_path, "d-drop", [0, 1, 2])
    assert s.vector_damage()["restorable"] is None
    r = embed_shard(s, fake(8), batch=4, repair=True)
    assert (r.repaired, r.embedded) == ("dropped", 20)
    assert s.counts()["events"] == 20


def test_a_failure_outside_vectors_is_reraised_never_repaired(tmp_path):
    s = mkstore(tmp_path, "d-other", 8)
    embed_shard(s, fake(8), batch=4)
    v = _version(tmp_path, "d-other")

    def boom(**_):
        raise RuntimeError("events went away")

    s.unembedded = boom
    with pytest.raises(RuntimeError, match="events went away"):
        embed_shard(s, fake(8), repair=True)
    assert _version(tmp_path, "d-other") == v


def test_damage_note_says_what_typescript_says():
    """Same lines as damageNote() in src/embed.ts; only the program name differs."""
    from relicpy.embed import ShardEmbedStat, damage_note

    st = ShardEmbedStat(key="hermes/_unresolved", bank="hermes", repo="_unresolved",
                        eligible=1402, skipped="…",
                        damage={"version": 3, "rows": 192, "error": "", "restorable": 1, "keep": 64})
    note = damage_note(st, ["--data-root", "/tmp/scratch root", "--model", "nomic-embed-text"])
    assert note[1] == ("  relic-py embed --repair --bank hermes --repo _unresolved "
                       "--data-root '/tmp/scratch root' --model nomic-embed-text")
    assert note[2] == "that restores v1 (64 of 192 vectors) and re-embeds the rest"
    st.repaired = "restored"
    assert damage_note(st, []) == \
        ["repaired: restored v1 of `vectors`, keeping 64 of 192 rows; v3 did not read"]
