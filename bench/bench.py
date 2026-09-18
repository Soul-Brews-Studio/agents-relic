"""MRR@20 and recall@k for every retrieval method, on ONE shared pool.

MRR (mean reciprocal rank): 1.0 means the right document was always first, 0.5 means
typically second. Reported alongside recall@1/@10 because MRR alone hides whether a
method is "usually first" or "occasionally first, often twentieth".
"""
import json, shutil, time
import lancedb, numpy as np

pool = json.load(open("/tmp/pool.json"))
queries = json.load(open("/tmp/queries.json"))
K = 20
uids = [r["uid"] for r in pool]
texts = [" ".join(r["text"].split()) for r in pool]
idx_of = {u: i for i, u in enumerate(uids)}

def score(ranked_uids, want):
    """Reciprocal rank of the wanted uid in a ranked list, 0 if absent."""
    for i, u in enumerate(ranked_uids[:K], 1):
        if u == want:
            return 1.0 / i
    return 0.0

results = {}

# ---------------------------------------------------------------- FTS (ICU), the baseline
shutil.rmtree("/tmp/bench_fts", ignore_errors=True)
db = lancedb.connect("/tmp/bench_fts")
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
json.dump({"uids": uids, "texts": texts}, open("/tmp/bench_docs.json", "w"))
import pickle
pickle.dump(results, open("/tmp/bench_fts.pkl", "wb"))
