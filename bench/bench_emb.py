"""Embed the same pool with each candidate model, measure MRR and throughput.

The models and their prefixes live in bench_models.py, shared with the null check.
BENCH_MODELS="label,label" runs a subset.
"""
import gc, json, os, pickle, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
import torch
from bench_models import BATCH, encode_docs, load, pick, runtime

docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
uids, texts = docs["uids"], docs["texts"]
# BENCH_DEDUP=1 scores an identical copy of the target as the target — see bench.py.
# Built on the FULL texts, before any cut below: two docs that agree only on their first
# 2,000 characters are two documents.
same = {}
if os.environ.get("BENCH_DEDUP") == "1":
    by_text = {}
    for u, x in zip(uids, texts):
        by_text.setdefault(x, set()).add(u)
    same = {u: by_text[x] for u, x in zip(uids, texts)}
# `relic embed` cuts every text at max_chars (2,000) before encoding; BENCH_MAX_CHARS
# reproduces that. Unset, a model gets the whole document, as in the 2026-09-18 run —
# which flatters a long-window model on spans FTS can reach and relic embed cannot.
if os.environ.get("BENCH_MAX_CHARS"):
    texts = [x[:int(os.environ["BENCH_MAX_CHARS"])] for x in texts]
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))
K = 20
results = pickle.load(open(os.environ.get("BENCH_FTS", "/tmp/bench_fts.pkl"), "rb"))

def score(ranked, want):
    ok = same.get(want, {want})
    for i, u in enumerate(ranked[:K], 1):
        if u in ok:
            return 1.0 / i
    return 0.0

for label, name, qpre, dpre in pick(os.environ.get("BENCH_MODELS")):
    t0 = time.time()
    try:
        m = load(name)
    except Exception as e:
        print(f"  {label}: unavailable ({str(e)[:50]})")
        continue
    load_s = time.time() - t0
    D, enc_s, cached = encode_docs(m, name, dpre, texts)
    thru = len(texts) / enc_s

    t0 = time.time()
    Q = m.encode([qpre + q["q"] for q in queries], normalize_embeddings=True,
                 batch_size=BATCH, show_progress_bar=False)
    q_ms = (time.time() - t0) / len(queries) * 1000

    # q_ms above is a BATCH amortised over its queries, which is not what an interactive
    # search pays: it encodes one query, alone. Timed separately, after a warm-up.
    for q in queries[:3]:
        m.encode([qpre + q["q"]], normalize_embeddings=True, show_progress_bar=False)
    one = []
    for q in queries[:50]:
        t1 = time.time()
        m.encode([qpre + q["q"]], normalize_embeddings=True, show_progress_bar=False)
        one.append((time.time() - t1) * 1000)

    sims = Q @ D.T
    rr = []
    for i, q in enumerate(queries):
        top = np.argpartition(-sims[i], K)[:K]
        top = top[np.argsort(-sims[i][top])]
        rr.append((score([uids[j] for j in top], q["uid"]), q["thai"]))
    results[label] = (rr, q_ms, f"{runtime(name)}, {thru:.0f} docs/s{' (cached)' if cached else ''}, dim={D.shape[1]}, "
                                f"1 query {np.median(one):.0f} ms, load {load_s:.0f} s, seq {m.max_seq_length}, "
                                f"load avg {os.getloadavg()[0]:.0f}")
    print(f"  {label:<26} {'cached' if cached else 'encoded'} {len(texts)} docs in {enc_s:.1f}s "
          f"({thru:.0f}/s)  load avg {os.getloadavg()[0]:.0f}", flush=True)
    # One model resident at a time: a 1024-dim model beside the last one is memory the
    # other agents on this machine are also using.
    del m, D, Q, sims
    gc.collect()
    if torch.backends.mps.is_available():
        torch.mps.empty_cache()

pickle.dump(results, open(os.environ.get("BENCH_ALL", "/tmp/bench_all.pkl"), "wb"))
