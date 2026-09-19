"""Embed the same pool with each candidate model, measure MRR and throughput."""
import json, os, pickle, time, warnings
warnings.filterwarnings("ignore")
import numpy as np
from sentence_transformers import SentenceTransformer

docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
uids, texts = docs["uids"], docs["texts"]
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))
K = 20
results = pickle.load(open(os.environ.get("BENCH_FTS", "/tmp/bench_fts.pkl"), "rb"))

MODELS = [
    ("multilingual-MiniLM-L12", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", "", ""),
    ("multilingual-e5-small",   "intfloat/multilingual-e5-small", "query: ", "passage: "),
    ("all-MiniLM-L6 (en only)", "sentence-transformers/all-MiniLM-L6-v2", "", ""),
]

def score(ranked, want):
    for i, u in enumerate(ranked[:K], 1):
        if u == want:
            return 1.0 / i
    return 0.0

for label, name, qpre, dpre in MODELS:
    try:
        m = SentenceTransformer(name, device="mps")
    except Exception as e:
        print(f"  {label}: unavailable ({str(e)[:50]})")
        continue
    t0 = time.time()
    D = m.encode([dpre + x for x in texts], normalize_embeddings=True,
                 batch_size=64, show_progress_bar=False)
    enc_s = time.time() - t0
    thru = len(texts) / enc_s

    t0 = time.time()
    Q = m.encode([qpre + q["q"] for q in queries], normalize_embeddings=True,
                 batch_size=64, show_progress_bar=False)
    q_ms = (time.time() - t0) / len(queries) * 1000

    sims = Q @ D.T
    rr = []
    for i, q in enumerate(queries):
        top = np.argpartition(-sims[i], K)[:K]
        top = top[np.argsort(-sims[i][top])]
        rr.append((score([uids[j] for j in top], q["uid"]), q["thai"]))
    results[label] = (rr, q_ms, f"{thru:.0f} docs/s, dim={D.shape[1]}")
    print(f"  {label:<26} encoded {len(texts)} docs in {enc_s:.1f}s ({thru:.0f}/s)")

pickle.dump(results, open(os.environ.get("BENCH_ALL", "/tmp/bench_all.pkl"), "wb"))
