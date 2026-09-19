"""Do FTS and embeddings fail on the SAME queries, or different ones?

"Which is better" is already answered and it flips by query style. The question that
decides whether anything gets built is complementarity: if the two methods miss the same
queries, a second index buys nothing and the loser should simply be dropped. If they miss
DIFFERENT queries, the gap is routable and an explicit semantic mode has a job.

Three measurements, run over both query sets so the contrast is visible:

  1. a 2x2 hit contingency — FTS hit@20 x embedding hit@20, and the ORACLE bound
     (either one got it), which is the ceiling any router could reach
  2. Jaccard overlap of the two top-20 uid SETS — an earlier measurement on a different
     corpus put this at 0.009-0.018; reproduce it here or kill it
  3. RRF fusion at several k. It LOST on known-item (0.890 -> 0.822) because k=60 weights
     a weak list equally with a strong one. Paraphrase is the opposite regime, so the
     result there is not predictable from the first and is measured rather than assumed.
"""
import json
import os
import shutil
import warnings

warnings.filterwarnings("ignore")
import lancedb
import numpy as np
from sentence_transformers import SentenceTransformer

K = 20
docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
uids, texts = docs["uids"], docs["texts"]
idx_of = {u: i for i, u in enumerate(uids)}

MODEL = os.environ.get("BENCH_DIAG_MODEL", "intfloat/multilingual-e5-small")
m = SentenceTransformer(MODEL, device="mps")
D = m.encode(["passage: " + t for t in texts], normalize_embeddings=True,
             batch_size=64, show_progress_bar=False)

shutil.rmtree("/tmp/rel_fts", ignore_errors=True)
db = lancedb.connect("/tmp/rel_fts")
t = db.create_table("d", data=[{"uid": u, "text": x} for u, x in zip(uids, texts)])
t.create_fts_index("text", use_tantivy=False, base_tokenizer="icu",
                   stem=False, remove_stop_words=False, max_token_length=128)


def fts_rank(q, k=100):
    try:
        return [r["uid"] for r in t.search(q, query_type="fts").limit(k).to_list()]
    except Exception:
        return []


def rr(ranked, want, k=K):
    for i, u in enumerate(ranked[:k], 1):
        if u == want:
            return 1.0 / i
    return 0.0


def rrf(a, b, k=60, n=K):
    """Reciprocal rank fusion. k controls how fast rank advantage decays; the fleet
    default is 60, which is exactly what made it lose when one list is much better."""
    s = {}
    for lst in (a, b):
        for i, u in enumerate(lst, 1):
            s[u] = s.get(u, 0.0) + 1.0 / (k + i)
    return [u for u, _ in sorted(s.items(), key=lambda kv: -kv[1])][:n]


for label, path in (("KNOWN-ITEM", os.environ.get("BENCH_QUERIES", "/tmp/queries.json")),
                    ("PARAPHRASE", os.environ.get("BENCH_PARA", "/tmp/queries_para.json"))):
    qs = json.load(open(path))
    Q = m.encode(["query: " + q["q"] for q in qs], normalize_embeddings=True,
                 batch_size=64, show_progress_bar=False)
    sims = Q @ D.T

    f_hit, e_hit, f_rr, e_rr, o_rr, jac = [], [], [], [], [], []
    rrf_rr = {k: [] for k in (10, 60, 200)}
    for i, q in enumerate(qs):
        want = q["uid"]
        fl = fts_rank(q["q"])
        order = np.argsort(-sims[i])[:100]
        el = [uids[j] for j in order]
        f, e = rr(fl, want), rr(el, want)
        f_rr.append(f); e_rr.append(e); o_rr.append(max(f, e))
        f_hit.append(f > 0); e_hit.append(e > 0)
        A, B = set(fl[:K]), set(el[:K])
        jac.append(len(A & B) / len(A | B) if (A | B) else 0.0)
        for k in rrf_rr:
            rrf_rr[k].append(rr(rrf(fl, el, k=k), want))

    f_hit = np.array(f_hit); e_hit = np.array(e_hit)
    both = int((f_hit & e_hit).sum()); only_f = int((f_hit & ~e_hit).sum())
    only_e = int((~f_hit & e_hit).sum()); neither = int((~f_hit & ~e_hit).sum())

    print(f"\n{'='*74}\n  {label}   n={len(qs)}   hit = target in top-{K}\n{'='*74}")
    print(f"                       e5 HIT   e5 MISS")
    print(f"    FTS HIT          {both:8d}  {only_f:8d}")
    print(f"    FTS MISS         {only_e:8d}  {neither:8d}")
    print(f"\n    FTS alone      recall@{K} {f_hit.mean():6.1%}   MRR {np.mean(f_rr):.3f}")
    print(f"    e5 alone       recall@{K} {e_hit.mean():6.1%}   MRR {np.mean(e_rr):.3f}")
    print(f"    ORACLE (either) recall@{K} {(f_hit | e_hit).mean():6.1%}   MRR {np.mean(o_rr):.3f}"
          f"   <- ceiling for any router")
    gain = (f_hit | e_hit).mean() - max(f_hit.mean(), e_hit.mean())
    print(f"    routable gap                {gain:+6.1%} over the better single method")
    print(f"\n    top-{K} set overlap (Jaccard)  mean {np.mean(jac):.4f}"
          f"   median {np.median(jac):.4f}   share disjoint {np.mean(np.array(jac) == 0):.1%}")
    print(f"\n    RRF fusion   " + "   ".join(
        f"k={k}: {np.mean(v):.3f}" for k, v in rrf_rr.items())
        + f"   (best single {max(np.mean(f_rr), np.mean(e_rr)):.3f})")
