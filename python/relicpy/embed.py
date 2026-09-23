"""Embedding the index — the WRITE half only.

`index` never calls anything here, and that separation is the point. Embedding is
expensive, optional, and was measured to LOSE to the full-text index on this corpus
(FTS 0.890 MRR@20 against 0.600 for the best of three models — see bench/README.md).
So it is a second pass over an index that is already complete and already answers:
"index first, embed later", with later meaning "if at all".

Everything written lands in the per-shard `vectors` table, never on `events`. See
`vector_row_model()` in models.py for the measurement behind that.
"""

from __future__ import annotations

import json
import math
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Callable, Optional

from .langs import EmbedCheck, check_embed_model
from .models import Scope
from .query import pick_shards
from .store import LanceStore

DEFAULT_OLLAMA = "http://localhost:11434"
# embed's default: the best vector model bench/ measured on this corpus, with its prompts (#101).
DEFAULT_MODEL = "embeddinggemma"

# Model-card prompts for the Ollama models that want them — OLLAMA_PROMPTS in
# src/embed.ts, entry for entry (test_embed.py compares the two). Ollama sends text as
# given, and embeddinggemma without its prompts falls from 0.318 to 0.170 paraphrase MRR
# (bench/README.md, #122). `doc` goes on what embed writes, `query` on a search string.
# Keyed by model name without its Ollama tag. A model with no entry is sent raw text.
OLLAMA_PROMPTS: dict[str, dict[str, str]] = {
    "embeddinggemma": {"doc": "title: none | text: ", "query": "task: search result | query: "},
}


# --------------------------------------------------------------------- providers


@dataclass
class Provider:
    """`id` is what goes on disk in VectorRow.model — provider-qualified, so a table
    written by ollama and one written by sentence-transformers never look alike."""

    id: str
    encode: Callable[[list[str]], list[list[float]]]


def ollama_prompts(model: str) -> Optional[dict[str, str]]:
    return OLLAMA_PROMPTS.get(re.sub(r":[^:/]*$", "", model))


def _ollama_id(model: str, prefix: str) -> str:
    return f"ollama:{model}" + (f"+{prefix.strip()}" if prefix else "")


def ollama_provider(model: str, host: str = DEFAULT_OLLAMA,
                    prefix: Optional[str] = None) -> Provider:
    """Ollama over HTTP, on urllib — no dependency added to a 3-dependency tool.

    The DEFAULT for both implementations, and the reason `relic embed` and
    `relic-py embed` are the same command rather than two: neither needs a model
    runtime of its own.

    Models measured locally, 2026-09-18, dim read off the live response:

        all-minilm             384   en only   cos(en, th-translation) +0.187
        nomic-embed-text       768                                    +0.467
        mxbai-embed-large     1024                                    +0.479
        qwen3-embedding:0.6b  1024   multi                            +0.572
        bge-m3                1024   multi                            +0.626
        embeddinggemma         768   multi    paraphrase MRR 0.318 with its prompts (#122)

    That cosine is a SMOKE TEST, not a benchmark: one English string against its Thai
    translation, which says whether a model places the two languages in one space at
    all, and nothing about ranking quality. The same numbers, as data, are
    MEASURED_MODELS in langs.py — what the embed check reads.

    `prefix` defaults to the model's OLLAMA_PROMPTS document prompt and is recorded in
    the id, as st_provider records e5's.
    """
    base = host.rstrip("/")
    pre = (ollama_prompts(model) or {}).get("doc", "") if prefix is None else prefix

    def encode(texts: list[str]) -> list[list[float]]:
        req = urllib.request.Request(
            f"{base}/api/embed",
            data=json.dumps({"model": model,
                             "input": [pre + t for t in texts] if pre else texts}).encode(),
            headers={"content-type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            j = json.loads(r.read())
        if j.get("error"):
            raise RuntimeError(f"ollama: {j['error']}")
        vecs = j.get("embeddings") or []
        # A short batch back is worse than an error: the rows would pair to the wrong
        # uids and every vector in the batch would be silently mislabelled.
        if len(vecs) != len(texts):
            raise RuntimeError(f"ollama returned {len(vecs)} vectors for {len(texts)} inputs")
        return vecs

    return Provider(id=_ollama_id(model, pre), encode=encode)


def st_provider(model: str, device: Optional[str] = None,
                query_prefix: str = "", doc_prefix: str = "") -> Provider:
    """sentence-transformers, in-process. TypeScript reaches the SAME models through
    `relicpy.embed_server`, which wraps this library behind a JSON-lines pipe rather
    than porting it — adding a model runtime to the TypeScript side would mean a
    torch-sized dependency in a tool that has three.

    So both implementations offer `--provider st` and both produce the same provider id,
    which is load-bearing: the model-mismatch guard compares ids, so a divergence would
    make each implementation refuse the other's shards.

    It exists because it reaches models ollama does not serve — notably
    `intfloat/multilingual-e5-small`: 384 dims AND multilingual, which is exactly the
    combination the ollama catalogue on this machine lacks (all-minilm is 384 but
    English-only; bge-m3 is multilingual but 1024).

    e5 models want asymmetric prefixes — "passage: " on documents, "query: " on queries.
    Passing the wrong one silently costs recall, so the prefix is recorded in the
    provider id and lands on disk with the vectors.
    """
    try:
        from sentence_transformers import SentenceTransformer  # noqa: PLC0415
    except ImportError as e:
        raise RuntimeError(
            "sentence-transformers is not installed. It is an optional extra, not a "
            "dependency of relicpy: run `uv run --with sentence-transformers relic-py "
            "embed --provider st ...`, or use --provider ollama (the default)."
        ) from e

    m = SentenceTransformer(model, device=device) if device else SentenceTransformer(model)

    def encode(texts: list[str]) -> list[list[float]]:
        # normalize_embeddings is left OFF here: normalisation happens in one place for
        # every provider (l2_normalise below), so `norm` on disk means the same thing
        # regardless of which backend wrote the row.
        return [list(map(float, v)) for v in
                m.encode([doc_prefix + t for t in texts], show_progress_bar=False)]

    tag = f"st:{model}" + (f"+{doc_prefix.strip()}" if doc_prefix else "")
    return Provider(id=tag, encode=encode)


def _doc_prefix(model: str) -> str:
    # e5 is the model the st provider exists for, and it is useless without its
    # prefix — so infer it rather than making silence the failure mode.
    return "passage: " if "e5" in model.lower() else ""


def provider_for(name: str, model: str, host: Optional[str] = None,
                 device: Optional[str] = None) -> Provider:
    if name == "ollama":
        return ollama_provider(model, host or DEFAULT_OLLAMA)
    if name == "st":
        return st_provider(model, device=device, doc_prefix=_doc_prefix(model))
    raise ValueError(f'unknown provider "{name}" — expected "ollama" or "st"')


def provider_id(name: str, model: str) -> str:
    """The id provider_for(name, model) would write, WITHOUT building the provider.

    Building an st provider loads the model — seconds of work, and an optional
    dependency — so the embed check, which must run before any of that, reads the id
    from here instead.
    """
    if name == "ollama":
        return _ollama_id(model, (ollama_prompts(model) or {}).get("doc", ""))
    if name == "st":
        doc = _doc_prefix(model)
        return f"st:{model}" + (f"+{doc.strip()}" if doc else "")
    raise ValueError(f'unknown provider "{name}" — expected "ollama" or "st"')


# ----------------------------------------------------------------------- helpers


def l2_normalise(v: list[float]) -> list[float]:
    """L2-normalise so LanceDB's default L2 distance ranks identically to cosine.

    Done on WRITE, so the choice is recorded on disk (VectorRow.norm) instead of living
    in whichever caller happens to run the search. A zero vector is left alone rather
    than divided by zero — it can only come from a provider failure, and NaNs would
    poison every later comparison silently.
    """
    n = math.sqrt(sum(x * x for x in v))
    return [x / n for x in v] if n > 0 else v


@dataclass
class ShardEmbedStat:
    key: str
    bank: str
    repo: str
    eligible: int = 0     # events passing the tier/length filter
    already: int = 0      # of those, already embedded
    pending: int = 0      # what this run would do (before --limit)
    embedded: int = 0     # what it actually did
    failed: int = 0
    model: str = ""
    dim: int = 0
    skipped: str = ""     # why this shard was left alone
    damage: Optional[dict] = None   # `vectors` failed to read — see LanceStore.vector_damage()
    repaired: str = ""    # what --repair did about it: "restored" | "dropped"


@dataclass
class EmbedTally:
    shards: list[ShardEmbedStat] = field(default_factory=list)
    embedded: int = 0
    failed: int = 0
    pending: int = 0
    ms: int = 0
    dry_run: bool = False
    provider_id: str = ""
    check: Optional[EmbedCheck] = None   # the scope's languages against the model, measured first
    refused: bool = False                # the check stopped this run before a provider was built


# -------------------------------------------------------------------- the driver


def _lance_reason(error: str) -> str:
    """The Lance error, without the stream wrapper or the rustc source location."""
    m = re.search(r"LanceError\([^)]*\): [^,\n]*", error)
    return m.group(0) if m else error.removeprefix("Error: ")[:120]


def _quote(a: str) -> str:
    return a if re.fullmatch(r"[\w@%+=:,./-]+", a) else "'" + a.replace("'", "'\\''") + "'"


def damage_note(st: ShardEmbedStat, carry: list[str], program: str = "relic-py") -> list[str]:
    """What to say under a shard whose `vectors` failed to read — the same lines as
    damageNote() in src/embed.ts. Unrepaired: the ONE command that repairs this shard,
    which is the run itself narrowed to that shard, with --data-root and the model
    carried along. Repaired: what was done, and what it kept."""
    d = st.damage
    if not d:
        return []
    if st.repaired == "restored":
        return [f"repaired: restored v{d['restorable']} of `vectors`, keeping {d['keep']:,} "
                f"of {d['rows']:,} rows; v{d['version']} did not read"]
    if st.repaired == "dropped":
        return ["repaired: dropped `vectors` — no version of it read — so this run embeds "
                "the shard from scratch"]
    cmd = " ".join(_quote(a) for a in [program, "embed", "--repair", "--bank", st.bank,
                                       "--repo", st.repo, *carry])
    return [
        "`events` and the full-text index are untouched. To repair this shard's vectors only:",
        f"  {cmd}",
        "no version of the table reads, so that drops it and re-embeds the shard"
        if d["restorable"] is None else
        f"that restores v{d['restorable']} ({d['keep']:,} of {d['rows']:,} vectors) "
        "and re-embeds the rest",
    ]


def embed_shard(store: LanceStore, p: Provider, *, batch: int = 64,
                limit: Optional[int] = None, main_tiers: bool = True,
                min_chars: int = 24, max_chars: int = 2000,
                dry_run: bool = False, reset: bool = False, repair: bool = False,
                on_progress: Optional[Callable[[int, int], None]] = None) -> ShardEmbedStat:
    """One shard. Resumable by construction: the anti-join is against what is ON DISK,
    so an interrupted run is re-entered by running the command again."""
    st = ShardEmbedStat(key="", bank="", repo="", model=p.id)
    st.eligible = store.embeddable_count(main_tiers=main_tiers, min_chars=min_chars)
    # --reset before the stats read, so the mismatch guard below sees the post-drop
    # state rather than refusing on vectors this run is about to discard anyway.
    if reset and not dry_run:
        store.drop_vectors()

    try:
        prior = store.vector_stats()
        # A FixedSizeList has ONE width. Writing a 1024-dim vector into a table created
        # at 384 fails mid-batch, after an arbitrary amount of work has already landed —
        # so the mismatch is caught before the first HTTP call and the shard is skipped
        # with a reason, rather than half-written. Saying so is cheaper than discovering
        # it 40 minutes into a backfill.
        if prior and prior["rows"] > 0 and prior["model"] and prior["model"] != p.id:
            st.already, st.dim = prior["rows"], prior["dim"]
            st.skipped = (f"holds {prior['rows']} vectors from {prior['model']} "
                          f"(dim {prior['dim']}); re-embed with {p.id} by adding --reset "
                          f"(drops this shard's vectors table only)")
            return st
        todo = store.unembedded(limit=limit, main_tiers=main_tiers, min_chars=min_chars)
    except Exception as err:
        # A VECTORS TABLE THAT NO LONGER READS (#105) — see embedShard() in
        # src/embed.ts. Diagnosed only after a read failed, so a healthy shard pays
        # nothing. If `vectors` still reads, the fault is elsewhere and is re-raised
        # unchanged: nothing is dropped on a guess. A dry run never repairs.
        damage = store.vector_damage()
        if not damage:
            raise
        if not repair or dry_run:
            st.damage = damage
            st.skipped = (f"vectors table unreadable at v{damage['version']} — "
                          f"{_lance_reason(damage['error'])}")
            return st
        repaired = store.repair_vectors(damage)
        # Start over on the repaired table; repair off, so a table that still fails is
        # reported rather than repaired in a loop.
        again = embed_shard(store, p, batch=batch, limit=limit, main_tiers=main_tiers,
                            min_chars=min_chars, max_chars=max_chars, dry_run=dry_run,
                            on_progress=on_progress)
        again.damage, again.repaired = damage, repaired
        return again
    st.already = (prior or {}).get("rows", 0)
    st.pending = len(todo)
    st.dim = (prior or {}).get("dim", 0)
    if dry_run or not todo:
        return st

    for i in range(0, len(todo), max(1, batch)):
        chunk = todo[i:i + max(1, batch)]
        try:
            vecs = p.encode([c["text"][:max_chars] for c in chunk])
            widths = {len(v) for v in vecs}
            # Every row in one table must share a width; a provider that changes its
            # mind mid-run would otherwise corrupt the shard one batch at a time.
            if len(widths) != 1:
                raise RuntimeError(f"provider returned mixed dims: {sorted(widths)}")
            dim = widths.pop()
            if st.dim and dim != st.dim:
                raise RuntimeError(f"dim changed mid-run: {st.dim} -> {dim}")
            st.dim = dim
            at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())
            store.put_vectors([{"uid": c["uid"], "embedding": l2_normalise(v),
                                "model": p.id, "dim": float(dim), "norm": "l2",
                                "embedded_at": at}
                               for c, v in zip(chunk, vecs)], dim)
            st.embedded += len(chunk)
        except Exception:
            # One bad batch must not end a backfill that is resumable anyway — those
            # uids simply stay pending and the next run picks them up.
            st.failed += len(chunk)
        if on_progress:
            on_progress(st.embedded, len(todo))
    return st


def embed_shards(s: Scope, *, provider: str = "ollama", model: str = DEFAULT_MODEL,
                 host: Optional[str] = None, device: Optional[str] = None,
                 batch: int = 64, limit: Optional[int] = None,
                 main_tiers: bool = True, min_chars: int = 24, max_chars: int = 2000,
                 dry_run: bool = False, reset: bool = False, force: bool = False,
                 repair: bool = False,
                 scope_args: Optional[list[str]] = None,
                 on_check: Optional[Callable[[EmbedCheck], None]] = None,
                 on_check_progress: Optional[Callable[[int, int, str], None]] = None,
                 on_progress: Optional[Callable[[str, int, int], None]] = None,
                 p: Optional[Provider] = None) -> EmbedTally:
    """`p` is built from the flags unless a caller hands one in — the tests do, offline."""
    t0 = time.time()
    pid = p.id if p else provider_id(provider, model)
    # The scope's languages against the model, BEFORE any provider is built or called —
    # see check_embed_model. A dry run reports a refusal and still counts.
    check = check_embed_model(pid, s, main_tiers=main_tiers, min_chars=min_chars,
                              max_chars=max_chars, scope_args=scope_args, force=force,
                              on_progress=on_check_progress)
    if on_check:
        on_check(check)
    tally = EmbedTally(dry_run=dry_run, provider_id=pid, check=check,
                       refused=check.action == "refuse" and not dry_run)
    if tally.refused:
        tally.ms = int((time.time() - t0) * 1000)
        return tally
    p = p or provider_for(provider, model, host, device)
    for sh in pick_shards(s):
        try:
            store = LanceStore.open(sh.dir)
            st = embed_shard(
                store, p, batch=batch, limit=limit, main_tiers=main_tiers,
                min_chars=min_chars, max_chars=max_chars, dry_run=dry_run, reset=reset,
                repair=repair,
                on_progress=(lambda d, t, k=sh.key: on_progress(k, d, t)) if on_progress else None)
            st.key, st.bank, st.repo = sh.key, sh.bank, sh.repo
        except Exception as e:
            st = ShardEmbedStat(key=sh.key, bank=sh.bank, repo=sh.repo,
                                model=p.id, skipped=str(e)[:160])
        tally.shards.append(st)
        tally.embedded += st.embedded
        tally.failed += st.failed
        tally.pending += st.pending
    tally.ms = int((time.time() - t0) * 1000)
    return tally
