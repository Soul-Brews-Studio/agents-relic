"""The embed write path, with no network and no model runtime.

Every provider here is a local lambda, so a failure is about relicpy's code — batching,
resume, the dim guard — and never about whether ollama happens to be running.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess

import lancedb
import pytest

from relicpy.embed import Provider, embed_shard, embed_shards, l2_normalise, provider_for, provider_id
from relicpy.langs import CHECK_MIN_EVENTS, MEASURED_MODELS, check_embed_model, lang_of, render_embed_check
from relicpy.models import EventRow, FileRow, Scope
from relicpy.repo import shard_dir_for
from relicpy.store import LanceStore
from relicpy.types import uid_of


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
    # provider_id() is the id provider_for() writes, read without loading a model.
    for model, want in [
        ("intfloat/multilingual-e5-small", "st:intfloat/multilingual-e5-small+passage:"),
        ("sentence-transformers/all-MiniLM-L6-v2",
         "st:sentence-transformers/all-MiniLM-L6-v2"),
    ]:
        assert E.provider_id("st", model) == want
    assert E.provider_id("ollama", "all-minilm") == provider_for("ollama", "all-minilm").id


# ------------------------------------------------- the language check (#101)
#
# `embed` measures the scope it is about to embed before any provider is built, and
# refuses an English-only model on a scope that carries Thai unless --force. The rule
# and its reasons live in src/langs.ts; these pin the port to the same behaviour, and
# the two parity tests at the end run the TypeScript CLI over the same shard.

THAI = "สวัสดีครับ วันนี้อากาศดีมาก ขอบคุณมาก"
PROSE = "Fix the bug in the parser and add a test for it please"
THAI_MIX = [THAI] * 10 + [PROSE] * 20     # a third of the scope carries Thai


def mkroot(root, repos: dict, bank: str = "default") -> str:
    """One shard per repo under a data root; an event is text, or (text, tier)."""
    for repo, events in repos.items():
        s = LanceStore.open(shard_dir_for(f"github.com/o/{repo}", str(root), bank=bank))
        rows = [e if isinstance(e, tuple) else (e, "session") for e in events]
        s.put_events([EventRow(
            uid=uid_of("claude", f"{repo}.jsonl", i), session_uuid="s", file_path=f"/{repo}.jsonl",
            repo_key=f"github.com/o/{repo}", seq=float(i), role="user", ts="", text=text,
            source="claude", tier=tier, kind="transcript", worktree="", cwd="", org="o",
            project="", dir="", mem_type="", origin_session="") for i, (text, tier) in enumerate(rows)])
    return str(root)


def counting(pid: str):
    """A provider under a real model's id that counts calls: a refusal comes before the first."""
    calls = {"n": 0}

    def encode(texts):
        calls["n"] += 1
        return fake(8).encode(texts)

    return Provider(id=pid, encode=encode), calls


def vectors_in(root: str, repo: str):
    return LanceStore.open(shard_dir_for(f"github.com/o/{repo}", root)).vector_stats()


def test_an_english_only_model_on_a_thai_scope_is_refused_before_any_provider_call(tmp_path):
    root = mkroot(tmp_path, {"mix": THAI_MIX})
    p, calls = counting("ollama:all-minilm")
    seen = []
    t = embed_shards(Scope(data_root=root), p=p, on_check=seen.append)
    assert t.refused and seen == [t.check]
    assert (t.check.action, t.check.fit, t.check.verdict) == ("refuse", "english-only", "multilingual")
    assert abs(t.check.thai_share - 1 / 3) < 1e-9
    assert t.shards == [] and calls["n"] == 0 and vectors_in(root, "mix") is None
    assert [c.m.model for c in t.check.candidates] == [
        "bge-m3", "qwen3-embedding:0.6b", "intfloat/multilingual-e5-small",
        "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"]
    text = render_embed_check(t.check)
    assert "embed REFUSED — ollama:all-minilm is English-only, and this scope is not" in text
    assert "33.3% of eligible events carry Thai, at or above 1.0%" in text
    assert "-> relic embed --model bge-m3" in text
    assert "--force embeds with ollama:all-minilm anyway." in text


def test_force_proceeds_and_says_what_it_is_forcing(tmp_path):
    root = mkroot(tmp_path, {"mix": THAI_MIX})
    p, calls = counting("ollama:all-minilm")
    t = embed_shards(Scope(data_root=root), p=p, force=True)
    assert not t.refused and t.check.action == "forced"
    assert t.embedded == 30 and calls["n"] > 0
    assert vectors_in(root, "mix")["model"] == "ollama:all-minilm"
    assert "--force: embedding with ollama:all-minilm, which is English-only" in render_embed_check(t.check)


def test_a_multilingual_model_passes_silently_under_every_form_of_its_id(tmp_path):
    root = mkroot(tmp_path, {"mix": THAI_MIX})
    for pid in ("ollama:bge-m3", "ollama:bge-m3:latest", "st:intfloat/multilingual-e5-small+passage:"):
        c = embed_shards(Scope(data_root=root), p=counting(pid)[0], dry_run=True).check
        assert (c.action, c.fit) == ("pass", "fits")
        assert render_embed_check(c) == ""
    assert embed_shards(Scope(data_root=root), p=counting("ollama:bge-m3")[0]).embedded == 30


def test_an_unmeasured_model_gets_a_note_not_a_refusal(tmp_path):
    root = mkroot(tmp_path, {"mix": THAI_MIX})
    t = embed_shards(Scope(data_root=root), p=counting("ollama:nomic-embed-text-v2-moe")[0])
    assert not t.refused and (t.check.action, t.check.fit) == ("note", "unmeasured")
    assert t.embedded == 30
    text = render_embed_check(t.check)
    assert "ollama:nomic-embed-text-v2-moe is not measured here" in text and "REFUSED" not in text


def test_an_english_only_model_on_an_english_scope_passes_silently(tmp_path):
    root = mkroot(tmp_path, {"en": [PROSE] * 20})
    t = embed_shards(Scope(data_root=root), p=counting("ollama:all-minilm")[0])
    assert (t.check.action, t.check.verdict, t.check.thai_share) == ("pass", "english", 0)
    assert render_embed_check(t.check) == "" and t.embedded == 20


def test_dry_run_shows_the_same_check_and_still_counts_without_writing(tmp_path):
    root = mkroot(tmp_path, {"mix": THAI_MIX})
    p, calls = counting("ollama:all-minilm")
    t = embed_shards(Scope(data_root=root), p=p, dry_run=True)
    assert not t.refused and t.check.action == "refuse"
    assert t.pending == 30 and calls["n"] == 0 and vectors_in(root, "mix") is None
    assert "Without --force, a real run stops here" in render_embed_check(t.check, True)


def test_a_thin_sample_is_read_in_full_and_a_thick_one_stays_a_sample(tmp_path):
    # 1 in 64 of 30 events is zero or one event, which cannot see 1% of anything.
    thin = check_embed_model("ollama:all-minilm", Scope(data_root=mkroot(tmp_path / "a", {"mix": THAI_MIX})))
    assert (thin.rate, thin.events, thin.action) == (1.0, 30, "refuse")
    thick = check_embed_model("ollama:all-minilm",
                              Scope(data_root=mkroot(tmp_path / "b", {"big": [PROSE] * 2500})), sample=2)
    assert thick.rate == 0.5 and thick.events >= CHECK_MIN_EVENTS


def test_the_scope_flags_reach_the_check(tmp_path):
    root = mkroot(tmp_path, {"en": [PROSE] * 20})
    mkroot(tmp_path, {"notes": THAI_MIX}, bank="vault")
    act = lambda **kw: embed_shards(Scope(data_root=root, **kw), p=counting("ollama:all-minilm")[0],
                                    dry_run=True).check.action  # noqa: E731
    assert (act(), act(bank="default"), act(bank="vault"), act(repo="en"), act(repo="notes")) == \
        ("refuse", "pass", "refuse", "pass", "refuse")

    long = PROSE * 40 + " " + THAI            # 2,200 chars of English, then Thai
    flags = mkroot(tmp_path / "flags", {"en": [PROSE] * 20 + [(THAI, "subagent")] * 10
                                        + ["สวัสดีครับ"] * 10 + [long] * 10})

    def check(**kw):
        c = embed_shards(Scope(data_root=flags), p=counting("ollama:all-minilm")[0], dry_run=True, **kw).check
        return c.action, c.events

    assert check() == ("pass", 30)
    assert check(main_tiers=False) == ("refuse", 40)     # --all-tiers
    assert check(min_chars=4) == ("refuse", 40)
    assert check(max_chars=3000) == ("refuse", 30)


def test_the_cli_refuses_with_exit_1_and_json_stays_one_document(tmp_path, capsys):
    from relicpy.cli import main

    root = mkroot(tmp_path, {"mix": THAI_MIX})
    assert main(["embed", "--data-root", root]) == 1
    out = capsys.readouterr()
    assert "embed REFUSED — ollama:all-minilm is English-only" in out.err and out.out == ""
    assert main(["embed", "--data-root", root, "--json"]) == 1
    j = json.loads(capsys.readouterr().out)
    assert j["refused"] is True and j["shards"] == [] and j["check"]["action"] == "refuse"
    assert main(["embed", "--data-root", root, "--dry-run"]) == 0
    out = capsys.readouterr()
    assert "Without --force, a real run stops here" in out.err
    assert "30 pending" in out.out and "the language check refuses ollama:all-minilm" in out.out


def test_lang_of_agrees_with_the_typescript_table():
    """The fixtures and answers of test/langs.test.ts, verbatim."""
    for text, want in [
        (THAI, "th"),
        ("ใช้ rg แทน grep ทุกครั้ง please check the repo first", "th+en"),
        (PROSE, "en"),
        ('{"file_path":"/opt/Code/x.ts","old_string":"const a = b","new_string":"const a = c"}', "latin"),
        ("你好，世界。这是一个测试", "zh/ja"),
        ("안녕하세요 반갑습니다", "ko"),
        ("Привет, как дела у тебя сегодня?", "cyrillic"),
        ("12345 --- !!! 2026-09-23", "none"),
    ]:
        assert lang_of(text) == want, text


TS_REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _bun(args: list[str], home) -> subprocess.CompletedProcess:
    if not shutil.which("bun"):
        pytest.skip("bun not installed — cannot run the reference implementation")
    return subprocess.run(["bun", *args], cwd=TS_REPO, capture_output=True, text=True, timeout=300,
                          env={**os.environ, "HOME": str(home)})


def test_measured_models_match_the_typescript_table(tmp_path):
    out = _bun(["-e", "import { MEASURED_MODELS } from './src/embed.ts';"
                      " console.log(JSON.stringify(MEASURED_MODELS))"], tmp_path)
    assert out.returncode == 0, out.stderr
    assert json.loads(out.stdout) == [m.to_json() for m in MEASURED_MODELS]


def test_the_check_matches_typescript_over_one_shard(tmp_path):
    """Both CLIs, one data root: the same shares, verdict, action, candidates and commands.

    The root has what the rule reads: Thai, a non-Latin script that is not Thai, a
    subagent tier, a short event, and vectors already on disk that fit.
    """
    zh = "你好，世界。这是一个测试的句子" * 2
    root = mkroot(tmp_path / "root", {"mix": THAI_MIX + [zh] * 3 + [(THAI, "subagent")] * 4 + ["ok"] * 5})
    mkroot(tmp_path / "root", {"notes": [PROSE] * 12 + [zh]}, bank="vault")
    embed_shard(LanceStore.open(shard_dir_for("github.com/o/mix", root)),
                counting("st:intfloat/multilingual-e5-small+passage:")[0])

    ts = _bun(["src/cli.ts", "embed", "--data-root", root, "--dry-run", "--json"], tmp_path)
    assert ts.returncode == 0, ts.stderr
    want = json.loads(ts.stdout)["check"]
    check = embed_shards(Scope(data_root=root), dry_run=True, scope_args=["--data-root", root]).check
    got = check.to_json()
    for c in (want, got):
        c.pop("ms")
    assert got == want
    assert got["kept"] == "st:intfloat/multilingual-e5-small+passage:" and got["otherShare"] > 0
    # and the words: the block TypeScript printed is the block Python prints, but for the clock
    clock = lambda s: re.sub(r"· \d+\.\d s", "· N s", s).strip()  # noqa: E731
    assert clock(render_embed_check(check, True)) == clock(ts.stderr)
    assert "multilingual, measured here:" in ts.stderr


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
