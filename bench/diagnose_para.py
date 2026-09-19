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
"""
import json
import os
import warnings

warnings.filterwarnings("ignore")
import numpy as np
from sentence_transformers import SentenceTransformer

docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
queries = json.load(open(os.environ.get("BENCH_PARA", "/tmp/queries_para.json")))
uids, texts = docs["uids"], docs["texts"]
idx_of = {u: i for i, u in enumerate(uids)}

MODEL = os.environ.get("BENCH_DIAG_MODEL", "intfloat/multilingual-e5-small")
m = SentenceTransformer(MODEL, device="mps")
D = m.encode(["passage: " + t for t in texts], normalize_embeddings=True,
             batch_size=64, show_progress_bar=False)
Q = m.encode(["query: " + q["q"] for q in queries], normalize_embeddings=True,
             batch_size=64, show_progress_bar=False)
sims = Q @ D.T
DD = D @ D.T          # doc-to-doc, for "what came back instead"

ranks, top1_sim_to_target, zero = [], [], []
for i, q in enumerate(queries):
    want = idx_of[q["uid"]]
    order = np.argsort(-sims[i])
    rank = int(np.where(order == want)[0][0]) + 1
    ranks.append(rank)
    top1 = int(order[0])
    top1_sim_to_target.append(float(DD[top1, want]))
    if q["overlap"] == 0:
        zero.append(i)

ranks = np.array(ranks)
t1 = np.array(top1_sim_to_target)
print(f"  model {MODEL}   n={len(queries)} paraphrase queries, pool={len(uids)}\n")
for k in (1, 10, 20, 50, 100, 500):
    print(f"  recall@{k:<4} {(ranks <= k).mean():6.1%}")
print(f"  median rank of the target: {int(np.median(ranks))} of {len(uids)}")
print(f"  (random would be ~{len(uids)//2})\n")

miss = ranks > 20
# THE NULL, WITHOUT WHICH THE NEXT NUMBER IS MEANINGLESS.
#
# "cosine(what came back, the target) = 0.85" sounds like a near-duplicate and is
# worthless on its own: e5 embeddings are anisotropic, so two UNRELATED documents also
# sit high. Absolute thresholds like ">0.90 = near-duplicate" are a guess dressed as a
# measurement. The baseline below is what an unrelated pair actually scores under this
# model, and every similarity is reported as a percentile against it.
rng = np.random.default_rng(11)
ia = rng.integers(0, len(uids), 40000)
ib = rng.integers(0, len(uids), 40000)
keep = ia != ib
null = np.asarray(DD[ia[keep], ib[keep]])
print(f"  NULL — cosine between two RANDOM pool documents, same model:")
print(f"    median {np.median(null):.3f}   p90 {np.quantile(null, 0.90):.3f}"
      f"   p99 {np.quantile(null, 0.99):.3f}   max {null.max():.3f}\n")

pct = lambda v: float((null < v).mean())
print(f"  WHEN THE TARGET IS MISSED (rank > 20, n={int(miss.sum())}):")
print(f"    cosine(top-1 returned, true target)   median {np.median(t1[miss]):.3f}"
      f"   p90 {np.quantile(t1[miss], 0.9):.3f}")
print(f"    ...as a percentile of the null         median {pct(np.median(t1[miss])):6.1%}"
      f"   p90 {pct(np.quantile(t1[miss], 0.9)):6.1%}")
print(f"    share above the null's p99 ({np.quantile(null, 0.99):.3f})   "
      f"{(t1[miss] > np.quantile(null, 0.99)).mean():6.1%}"
      f"  <- plausibly a near-duplicate: retrieved well, scored wrong")
print(f"    share below the null's median ({np.median(null):.3f}) {(t1[miss] < np.median(null)).mean():6.1%}"
      f"  <- worse than a random doc: retrieval failed\n")

z = np.array(zero)
print(f"  ZERO-OVERLAP SUBSET (n={len(z)}) — no shared term with the target:")
for k in (10, 20, 100):
    print(f"    recall@{k:<4} {(ranks[z] <= k).mean():6.1%}")
print(f"    median rank {int(np.median(ranks[z]))}")
