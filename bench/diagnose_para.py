"""Is the paraphrase score low because retrieval is weak, or because scoring is unfair?

The paraphrase table says embeddings beat FTS 3x and that everything is bad in absolute
terms. Before believing the second half, two confounds have to be ruled out, and both
are measurable rather than arguable:

 1. SINGLE GROUND TRUTH. A paraphrase like "is the build ready to ship?" is answered by
    many documents in a 3,000-doc corpus of dev sessions, but exactly one is scored
    correct. Semantic retrieval is the method most punished by that, because finding a
    near-duplicate is precisely what it is good at. Measured here as: when the target is
    missed, how similar is what came back INSTEAD?

 2. CUTOFF. MRR@20 cannot distinguish "rank 21" from "rank 2,000". recall@100 can.

Neither result changes the ordering — it is already decided — but they decide how much
the absolute numbers are worth.

EVERY MODEL, NOT ONE. This used to measure e5-small only, with e5's prefixes hardcoded
beside a model switch. Anisotropy is a property of each model, so the null is too: a
threshold read off one model's null says nothing about another's. BENCH_MODELS picks a
subset by label; prefixes and cached document vectors come from bench_models.py.

Two nulls, because two kinds of threshold get set. Document-document (two random pool
documents) is the one dedup and clustering cutoffs sit on. Query-document (a query
against documents that are NOT its target) is the one a "semantic search only returns
hits above X" cutoff would sit on.
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")
import numpy as np
from bench_models import BATCH, encode_docs, load, pick, runtime

docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
queries = json.load(open(os.environ.get("BENCH_PARA", "/tmp/queries_para.json")))
uids, texts = docs["uids"], docs["texts"]
idx_of = {u: i for i, u in enumerate(uids)}
want = np.array([idx_of[q["uid"]] for q in queries])
# BENCH_DEDUP=1: an identical copy of the target counts as the target (see bench.py), so
# a query's rank is its best-placed copy and "missed" means no copy made the top 20.
copies = np.zeros((len(queries), len(uids)), dtype=bool)
copies[np.arange(len(queries)), want] = True
if os.environ.get("BENCH_DEDUP") == "1":
    same_text = np.array(texts, dtype=object)
    for i, w in enumerate(want):
        copies[i] = same_text == texts[w]
zero = np.array([q["overlap"] == 0 for q in queries])
n = len(queries)

ranks_by, null_by = {}, {}
for label, name, qpre, dpre in pick(os.environ.get("BENCH_MODELS")):
    try:
        m = load(name)
    except Exception as e:
        print(f"  {label}: unavailable ({str(e)[:50]})")
        continue
    D, _s, _cached = encode_docs(m, name, dpre, texts)
    Q = m.encode([qpre + q["q"] for q in queries], normalize_embeddings=True,
                 batch_size=BATCH, show_progress_bar=False)
    del m
    sims = Q @ D.T
    DD = D @ D.T          # doc-to-doc, for "what came back instead"
    order = np.argsort(-sims, axis=1)
    ranks = np.argmax(np.take_along_axis(copies, order, axis=1), axis=1) + 1
    t1 = DD[order[:, 0], want]                  # top-1 returned vs the true target

    # THE NULL, WITHOUT WHICH THE NEXT NUMBER IS MEANINGLESS.
    #
    # "cosine(what came back, the target) = 0.85" sounds like a near-duplicate and is
    # worthless on its own: e5 embeddings are anisotropic, so two UNRELATED documents
    # also sit high. Absolute thresholds like ">0.90 = near-duplicate" are a guess
    # dressed as a measurement. The baseline is what an unrelated pair actually scores
    # under this model, and every similarity is reported as a percentile against it.
    rng = np.random.default_rng(11)
    ia = rng.integers(0, len(uids), 40000)
    ib = rng.integers(0, len(uids), 40000)
    keep = ia != ib
    null = np.asarray(DD[ia[keep], ib[keep]])
    qd = sims[~copies]                          # never the target, nor a copy of it
    tgt = sims[np.arange(n), want]
    ranks_by[label] = ranks
    null_by[label] = (null, t1, ranks > 20, qd, tgt)

print(f"  n={n} paraphrase queries, pool={len(uids):,}   rank of the true target, full ranking\n")
print(f"  {'model':<26} {'@1':>6} {'@10':>6} {'@20':>6} {'@100':>6} {'@500':>6} {'median':>7}"
      f"   zero-overlap n={int(zero.sum())}: {'@20':>6} {'median':>7}")
print("  " + "-" * 100)
for label, r in ranks_by.items():
    print(f"  {label:<26}" + "".join(f" {(r <= k).mean():6.1%}" for k in (1, 10, 20, 100, 500))
          + f" {int(np.median(r)):>7}   {'':>21}{(r[zero] <= 20).mean():6.1%} {int(np.median(r[zero])):>7}")
print(f"  (random would be ~{len(uids) // 2})")

print(f"\n  NULL — cosine between two RANDOM pool documents, per model; and, when the target is"
      f"\n  missed (rank > 20), cosine(top-1 returned, true target) as a percentile of that null\n")
print(f"  {'model':<26} {'median':>7} {'p90':>6} {'p99':>6}   {'misses':>6} {'top1~tgt':>8} {'pctl':>6}"
      f" {'>p99':>6} {'<med':>6}")
print("  " + "-" * 88)
for label, (null, t1, miss, _qd, _tgt) in null_by.items():
    p99, med = np.quantile(null, 0.99), np.median(null)
    tm = np.median(t1[miss]) if miss.any() else np.nan
    print(f"  {label:<26} {med:7.3f} {np.quantile(null, 0.9):6.3f} {p99:6.3f}   {int(miss.sum()):>6}"
          f" {tm:8.3f} {(null < tm).mean():6.1%} {(t1[miss] > p99).mean():6.1%} {(t1[miss] < med).mean():6.1%}")
print(f"  >p99 = plausibly a near-duplicate: retrieved well, scored wrong."
      f"   <med = less related than a random doc: retrieval failed")

print(f"\n  QUERY-DOCUMENT — a query against documents that are NOT its target, vs its true target\n")
print(f"  {'model':<26} {'null med':>8} {'p99':>6} {'p99.9':>6}   {'target med':>10} {'target > null p99':>18}")
print("  " + "-" * 82)
for label, (_null, _t1, _miss, qd, tgt) in null_by.items():
    p99 = np.quantile(qd, 0.99)
    print(f"  {label:<26} {np.median(qd):8.3f} {p99:6.3f} {np.quantile(qd, 0.999):6.3f}"
          f"   {np.median(tgt):10.3f} {(tgt > p99).mean():18.1%}")
