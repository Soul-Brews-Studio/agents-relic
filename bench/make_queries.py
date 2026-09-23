"""Known-item retrieval: each query is a span lifted from ONE pool document, and the
task is to get that document back.

A span, not the whole text — quoting a document verbatim makes lexical search trivially
win and measures nothing. A contiguous 8-12 word span from the middle is what someone
half-remembering a conversation actually types.

BENCH_THAI_ONLY=1 draws targets from the Thai documents alone, BENCH_N at a time. The
default draw gives Thai ~28 of 200 queries, which is too few to decide anything about
Thai on; with the defaults the draw is unchanged, so the 200-query set stays comparable.
"""
import json, os, random, re

random.seed(4242)
pool = json.load(open(os.environ.get("BENCH_POOL", "/tmp/pool.json")))
THAI = re.compile(r"[฀-๿]")
N = int(os.environ.get("BENCH_N", "200"))
THAI_ONLY = os.environ.get("BENCH_THAI_ONLY") == "1"

def span(text, thai):
    body = " ".join(text.split())
    if thai:
        # Thai has no spaces; take a character window and let the tokenizer segment it.
        if len(body) < 60:
            return None
        i = random.randint(10, max(11, len(body) - 45))
        return body[i:i + 32]
    words = body.split()
    if len(words) < 25:
        return None
    i = random.randint(3, len(words) - 14)
    return " ".join(words[i:i + random.randint(8, 12)])

qs, used = [], set()
cands = [r for r in pool if THAI.search(r["text"])] if THAI_ONLY else pool[:]
random.shuffle(cands)
for r in cands:
    if len(qs) >= N:
        break
    if r["uid"] in used:
        continue
    thai = bool(THAI.search(r["text"]))
    s = span(r["text"], thai)
    if not s or len(s) < 12:
        continue
    used.add(r["uid"])
    qs.append({"q": s, "uid": r["uid"], "thai": thai})
json.dump(qs, open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json"), "w"))
print(f"  {len(qs)} queries — {sum(q['thai'] for q in qs)} Thai, {sum(not q['thai'] for q in qs)} non-Thai")
print("  sample en:", next((q['q'] for q in qs if not q['thai']), "")[:70])
print("  sample th:", next(q['q'] for q in qs if q['thai'])[:50])
