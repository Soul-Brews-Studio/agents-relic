"""The paraphrase report: overall, by language, and STRATIFIED BY QUERY/DOC OVERLAP.

The stratification is the point. A paraphrase query that still echoes a rare identifier
is a known-item query in disguise, and averaging it in would let the generator decide
the result. Reading MRR across overlap bands says which regime each method is actually
winning in — and if a method only wins where overlap is high, it is winning the OLD
benchmark again.

Rows align with the query file by POSITION: bench.py and bench_emb.py both build their
score lists by iterating `queries` in order, so index i is queries[i]. That is a
contract between three files; it is asserted here rather than assumed.
"""
import json
import os
import pickle

import numpy as np

r = pickle.load(open(os.environ.get("BENCH_ALL", "/tmp/bench_all_para.pkl"), "rb"))
queries = json.load(open(os.environ.get("BENCH_PARA", "/tmp/queries_para.json")))
known_path = os.environ.get("BENCH_ALL_KNOWN", "/tmp/bench_all.pkl")
known = pickle.load(open(known_path, "rb")) if os.path.exists(known_path) else None

K = 20
ORDER = ["FTS (ICU)", "multilingual-e5-small", "all-MiniLM-L6 (en only)",
         "multilingual-MiniLM-L12"]
BANDS = [("0 (no shared terms)", lambda o: o == 0),
         ("0 - 0.05", lambda o: 0 < o <= 0.05),
         ("0.05 - 0.15", lambda o: 0.05 < o <= 0.15),
         ("> 0.15", lambda o: o > 0.15)]

ov = np.array([q["overlap"] for q in queries])
th = np.array([bool(q["thai"]) for q in queries])

for name, (rr, _ms, _note) in r.items():
    assert len(rr) == len(queries), (
        f"{name}: {len(rr)} scores for {len(queries)} queries — the position contract "
        f"between bench*.py and this report is broken; do not read these numbers")

print(f"  n={len(queries)} PARAPHRASE queries  ·  pool=3,000 docs  ·  MRR@{K}")
print(f"  median query/doc overlap {np.median(ov):.3f}"
      f"   ·   {int((ov == 0).sum())} queries share no term with their target\n")

print(f"  {'method':<26} {'MRR':>6} {'R@1':>6} {'R@10':>6} {'miss':>6} {'MRR th':>7} {'MRR en':>7}")
print("  " + "-" * 70)
scores = {}
for k in ORDER:
    if k not in r:
        continue
    v = np.array([x[0] for x in r[k][0]])
    scores[k] = v
    print(f"  {k:<26} {v.mean():6.3f} {(v == 1.0).mean():6.1%} {(v >= 1/10).mean():6.1%} "
          f"{(v == 0).mean():6.1%} {v[th].mean():7.3f} {v[~th].mean():7.3f}")

print(f"\n  BY QUERY/DOC OVERLAP — does the win survive when no words are shared?\n")
hdr = f"  {'band':<22} {'n':>4}"
for k in ORDER:
    if k in scores:
        hdr += f" {k.split(' (')[0][:13]:>14}"
print(hdr)
print("  " + "-" * (len(hdr) - 2))
for label, pred in BANDS:
    m = np.array([pred(o) for o in ov])
    if not m.any():
        continue
    row = f"  {label:<22} {int(m.sum()):>4}"
    for k in ORDER:
        if k in scores:
            row += f" {scores[k][m].mean():>14.3f}"
    print(row)

if known:
    print(f"\n  PAIRED AGAINST THE KNOWN-ITEM RUN — same 200 documents, different queries\n")
    print(f"  {'method':<26} {'known-item':>11} {'paraphrase':>11} {'delta':>9}")
    print("  " + "-" * 60)
    for k in ORDER:
        if k in scores and k in known:
            a = np.array([x[0] for x in known[k][0]]).mean()
            b = scores[k].mean()
            print(f"  {k:<26} {a:11.3f} {b:11.3f} {b - a:+9.3f}")
    print(f"\n  (known-item numbers read from {known_path})")
