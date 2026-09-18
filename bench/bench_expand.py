"""Query expansion: translate the query, search BOTH, fuse.

Thai models are not installed, so the honest test of the MECHANISM uses an installed
pair. en->fr->search-both measures the plumbing and the cost; it cannot measure the
Thai recall win, and this reports it as such rather than implying otherwise.
"""
import json, pickle, subprocess, time
import lancedb

BIN = "/opt/Code/github.com/Soul-Brews-Studio/agents-relic/wt/agents-relic-kind-vs-tier-18sep-fri2026/tools/bin/apple-translate"
docs = json.load(open("/tmp/bench_docs.json"))
uids, texts = docs["uids"], docs["texts"]
queries = json.load(open("/tmp/queries.json"))
K = 20
results = pickle.load(open("/tmp/bench_all.pkl", "rb"))

db = lancedb.connect("/tmp/bench_fts")
t = db.open_table("d")

def fts(q, k=K):
    try:
        return [r["uid"] for r in t.search(q, query_type="fts").limit(k).to_list()]
    except Exception:
        return []

def translate(texts_in, src, dst):
    p = subprocess.run([BIN], input=json.dumps({"from": src, "to": dst, "texts": texts_in}),
                       capture_output=True, text=True, timeout=600)
    if p.returncode != 0:
        return None, 0
    d = json.loads(p.stdout)
    return d["translations"], d["ms"]

# One batch for all 200 queries — the per-query cost of a spawn would swamp the result.
en_qs = [q["q"] for q in queries]
t0 = time.time()
fr, ms = translate(en_qs, "en", "fr")
batch_s = time.time() - t0
print(f"  translated {len(en_qs)} queries en->fr in {batch_s:.1f}s ({batch_s/len(en_qs)*1000:.0f} ms/query, framework reported {ms} ms)")

def rrf(lists, k=60):
    """Reciprocal rank fusion. k=60 is the fleet default — and the thing measured as
    HARMFUL last time, so it is reported, not assumed."""
    s = {}
    for lst in lists:
        for i, u in enumerate(lst, 1):
            s[u] = s.get(u, 0) + 1.0 / (k + i)
    return [u for u, _ in sorted(s.items(), key=lambda kv: -kv[1])]

def score(ranked, want):
    for i, u in enumerate(ranked[:K], 1):
        if u == want:
            return 1.0 / i
    return 0.0

t0 = time.time()
rr = []
for q, f in zip(queries, fr or en_qs):
    a = fts(q["q"])
    b = fts(f) if f else []
    rr.append((score(rrf([a, b]), q["uid"]), q["thai"]))
ms_q = (time.time() - t0) / len(queries) * 1000
results["FTS + expand(fr) RRF"] = (rr, ms_q, f"+{batch_s/len(en_qs)*1000:.0f} ms translate")

# And expansion WITHOUT fusion — original list first, translated appended.
rr2 = []
for q, f in zip(queries, fr or en_qs):
    a = fts(q["q"])
    b = [u for u in (fts(f) if f else []) if u not in a]
    rr2.append((score(a + b, q["uid"]), q["thai"]))
results["FTS + expand(fr) append"] = (rr2, ms_q, "original ranks preserved")
pickle.dump(results, open("/tmp/bench_all.pkl", "wb"))
print("  expansion arms done")
