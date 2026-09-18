import pickle
import numpy as np
r = pickle.load(open("/tmp/bench_all.pkl", "rb"))
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
         "multilingual-MiniLM-L12", "multilingual-e5-small", "all-MiniLM-L6 (en only)"]
print(f"  n={stats(r['FTS (ICU)'][0])['n']} known-item queries  ·  pool=3,000 docs  ·  MRR@{K}\n")
print(f"  {'method':<26} {'MRR':>6} {'R@1':>6} {'R@10':>6} {'miss':>6} {'MRR th':>7} {'MRR en':>7}  {'query cost':<22} notes")
print("  " + "-" * 122)
for k in order:
    if k not in r: continue
    rr, ms, note = r[k]
    s = stats(rr)
    print(f"  {k:<26} {s['mrr']:6.3f} {s['r1']:6.1%} {s['r10']:6.1%} {s['miss']:6.1%} "
          f"{s['mrr_th']:7.3f} {s['mrr_en']:7.3f}  {ms:>6.1f} ms/query        {note}")
print(f"\n  Thai subset n={stats(r['FTS (ICU)'][0])['n_th']}")
