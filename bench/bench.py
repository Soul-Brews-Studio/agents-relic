"""MRR@20 and recall@k for every retrieval method, on ONE shared pool.

MRR (mean reciprocal rank): 1.0 means the right document was always first, 0.5 means
typically second. Reported alongside recall@1/@10 because MRR alone hides whether a
method is "usually first" or "occasionally first, often twentieth".
"""
import json, os, shutil, time
import lancedb, numpy as np

pool = json.load(open(os.environ.get("BENCH_POOL", "/tmp/pool.json")))
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))
K = 20
uids = [r["uid"] for r in pool]
texts = [" ".join(r["text"].split()) for r in pool]
idx_of = {u: i for i, u in enumerate(uids)}

# BENCH_DEDUP=1: identical texts are ONE document. build_pool.py now puts each text in
# the pool once, so on its pools this changes nothing; it is for pools built before
# that. The codex-only pool of 2026-09-23 held 839 docs sharing their exact text with
# another, up to 89 copies, and a quarter of its targets had copies: with one uid as the
# answer, the target's rank among its own copies is decided by tie-breaking, which is
# noise, broken differently per method. Unset, scoring is by uid.
same = {}
if os.environ.get("BENCH_DEDUP") == "1":
    by_text = {}
    for u, x in zip(uids, texts):
        by_text.setdefault(x, set()).add(u)
    same = {u: by_text[x] for u, x in zip(uids, texts)}

def score(ranked_uids, want):
    """Reciprocal rank of the wanted uid (or an identical copy) in a ranked list, 0 if absent."""
    ok = same.get(want, {want})
    for i, u in enumerate(ranked_uids[:K], 1):
        if u in ok:
            return 1.0 / i
    return 0.0

results = {}

# ---------------------------------------------------------------- FTS (ICU), the baseline
# The index holds every pool text, so it goes wherever the pool goes (BENCH_FTS_DB) —
# a private pool must not leave a readable copy of itself in /tmp.
FTS_DB = os.environ.get("BENCH_FTS_DB", "/tmp/bench_fts")
shutil.rmtree(FTS_DB, ignore_errors=True)
db = lancedb.connect(FTS_DB)
t = db.create_table("d", data=[{"uid": u, "text": x} for u, x in zip(uids, texts)])
t.create_fts_index("text", use_tantivy=False, base_tokenizer="icu",
                   stem=False, remove_stop_words=False, max_token_length=128)

def fts_search(q, k=K):
    # A quoted phrase is how relic's own callers search; an unquoted one lets the
    # tokenizer treat punctuation as operators.
    try:
        return [r["uid"] for r in t.search(q, query_type="fts").limit(k).to_list()]
    except Exception:
        return []

t0 = time.time()
rr = [(score(fts_search(q["q"]), q["uid"]), q["thai"]) for q in queries]
fts_ms = (time.time() - t0) / len(queries) * 1000
results["FTS (ICU)"] = (rr, fts_ms, "—")
print(f"  FTS done  {fts_ms:.0f} ms/query")
json.dump({"uids": uids, "texts": texts}, open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json"), "w"))
import pickle
pickle.dump(results, open(os.environ.get("BENCH_FTS", "/tmp/bench_fts.pkl"), "wb"))
