import json, os, pickle
import numpy as np
from report_lang import by_language
r = pickle.load(open(os.environ.get("BENCH_ALL", "/tmp/bench_all.pkl"), "rb"))
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))
docs_path = os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")
n_pool = len(json.load(open(docs_path))["uids"]) if os.path.exists(docs_path) else 3000
K = 20

def stats(rr):
    v = np.array([x[0] for x in rr]); th = np.array([x[1] for x in rr])
    return dict(
        mrr=v.mean(),
        r1=(v == 1.0).mean(),
        r10=(v >= 1/10).mean(),
        miss=(v == 0).mean(),
        mrr_th=v[th].mean() if th.any() else float("nan"),
        mrr_en=v[~th].mean() if (~th).any() else float("nan"),
        n=len(v), n_th=int(th.sum()),
    )

order = ["FTS (ICU)", "FTS + expand(fr) append", "FTS + expand(fr) RRF",
         "multilingual-MiniLM-L12", "multilingual-e5-small", "all-MiniLM-L6 (en only)",
         "bge-m3", "Qwen3-Embedding-0.6B", "embeddinggemma-300m", "Qwen3-0.6B, no instruct",
         "bge-m3 (ollama)", "embeddinggemma (ollama)", "emb-gemma raw (ollama)"]
print(f"  n={stats(r['FTS (ICU)'][0])['n']} {os.environ.get('BENCH_LABEL', 'known-item')} queries  ·  pool={n_pool:,} docs  ·  MRR@{K}\n")
print(f"  {'method':<26} {'MRR':>6} {'R@1':>6} {'R@10':>6} {'miss':>6} {'MRR th':>7} {'MRR en':>7}  {'query cost':<22} notes")
print("  " + "-" * 122)
for k in order:
    if k not in r: continue
    rr, ms, note = r[k]
    s = stats(rr)
    print(f"  {k:<26} {s['mrr']:6.3f} {s['r1']:6.1%} {s['r10']:6.1%} {s['miss']:6.1%} "
          f"{s['mrr_th']:7.3f} {s['mrr_en']:7.3f}  {ms:>6.1f} ms/query        {note}")
print(f"\n  Thai subset n={stats(r['FTS (ICU)'][0])['n_th']}")
by_language(r, queries, order)
