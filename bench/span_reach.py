"""Can the model even SEE the span a known-item query was lifted from?

A known-item query is a span from anywhere in its target, and FTS indexes the whole
text. An embedding model reads only the first max_seq_length tokens, and the three
384-dim models read very different amounts: 128 tokens for multilingual-MiniLM-L12,
256 for all-MiniLM-L6, 512 for e5-small — against 8,192 for bge-m3. Thai costs more
tokens per character than English, so the cut lands earlier in a Thai document.

So "a bigger model closes the Thai gap" can be a bigger WINDOW, not a better space.
This splits every model's known-item MRR by whether the span lies inside its window.

It also counts what `relic embed` itself would show a model: it cuts every text at
2,000 characters (max_chars) before encoding, whatever the model's window.
"""
import json
import os
import pickle
import re
import warnings

warnings.filterwarnings("ignore")
import numpy as np
from sentence_transformers import SentenceTransformer
from transformers.utils import logging as hf_logging
from bench_models import pick

hf_logging.set_verbosity_error()   # "sequence longer than max length" is the point here

MAX_CHARS = 2000      # relic embed's default cut, src/cli.ts and relicpy/embed.py
THAI = re.compile(r"[฀-๿]")
docs = json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))
r = pickle.load(open(os.environ.get("BENCH_ALL", "/tmp/bench_all.pkl"), "rb"))
idx_of = {u: i for i, u in enumerate(docs["uids"])}
texts = docs["texts"]
th = np.array([bool(q["thai"]) for q in queries])

# Where each span ends, in characters of the text the models were given.
ends = []
for q in queries:
    off = texts[idx_of[q["uid"]]].find(q["q"])
    assert off >= 0, "span not found verbatim in its target — make_queries and bench disagree"
    ends.append(off + len(q["q"]))
ends = np.array(ends)
past = ends > MAX_CHARS
f = np.array([x[0] for x in r["FTS (ICU)"][0]]) if "FTS (ICU)" in r else None

print(f"  n={len(queries)} known-item queries   th n={int(th.sum())}   en n={int((~th).sum())}\n")
print(f"  relic embed cuts at {MAX_CHARS:,} chars: {int(past.sum())} spans ({past.mean():.1%}) end past it"
      f"  (th {past[th].mean() if th.any() else float('nan'):.1%}, en {past[~th].mean() if (~th).any() else float('nan'):.1%})"
      + (f";  FTS finds {(f[past] > 0).mean():.1%} of those" if f is not None and past.any() else ""))
print(f"\n  {'model':<26} {'window':>7}   {'span past window':>16} {'th':>6} {'en':>6}"
      f"   {'MRR in window':>13} {'MRR past (n)':>15}")
print("  " + "-" * 98)
for label, name, _qpre, dpre in pick(os.environ.get("BENCH_MODELS")):
    if label not in r or name.startswith("ollama:"):   # no local tokenizer to count with
        continue
    try:
        m = SentenceTransformer(name, device="cpu")
    except Exception as e:
        print(f"  {label}: unavailable ({str(e)[:50]})")
        continue
    tok, window = m.tokenizer, m.max_seq_length
    del m
    reach = np.array([len(tok(dpre + texts[idx_of[q["uid"]]][:e])["input_ids"]) <= window
                      for q, e in zip(queries, ends)])
    v = np.array([x[0] for x in r[label][0]])
    out = ~reach
    print(f"  {label:<26} {window:>7}   {out.mean():16.1%}"
          f" {out[th].mean() if th.any() else float('nan'):6.1%} {out[~th].mean() if (~th).any() else float('nan'):6.1%}"
          f"   {v[reach].mean():13.3f} {v[out].mean() if out.any() else float('nan'):9.3f} ({int(out.sum())})")
