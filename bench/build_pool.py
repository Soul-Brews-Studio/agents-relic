"""Sample a fair candidate pool: same documents for every retrieval method.

Comparing FTS on the whole 3.4 M-event index against embeddings on a 3,000-doc pool
would be rigged — a bigger candidate set is strictly harder. So every method searches
the SAME pool, built once here.
"""
import json, os, random, re, sys
# The repo's own python/ package, resolved from THIS file. It used to be an absolute
# path to one worktree, which silently benchmarked another checkout's code — or failed
# outright once that worktree was removed.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from relicpy.models import Scope
from relicpy.query import pick_shards
from relicpy.store import LanceStore

random.seed(1729)
POOL = 3000
THAI = re.compile(r"[฀-๿]")

rows, thai_rows = [], []
# Prose only, and a length band: a 12-char event has nothing to query with, and a
# 16 KB tool dump is not what anyone searches for.
for sh in pick_shards(Scope()):
    if len(rows) >= POOL * 4 and len(thai_rows) >= 400:
        break
    try:
        t = LanceStore.open(sh.dir)._existing("events")
        if t is None:
            continue
        for r in t.to_arrow().select(["uid", "text", "role", "repo_key"]).to_pylist():
            if r["role"] not in ("user", "assistant", "note", "memory"):
                continue
            n = len(r["text"])
            if not (200 <= n <= 4000):
                continue
            (thai_rows if THAI.search(r["text"]) else rows).append(r)
            if len(rows) >= POOL * 4 and len(thai_rows) >= 400:
                break
    except Exception:
        continue

random.shuffle(rows); random.shuffle(thai_rows)
# Deliberately over-sample Thai so the Thai number is not one query wide.
pool = rows[:POOL - 400] + thai_rows[:400]
random.shuffle(pool)
seen, uniq = set(), []
for r in pool:
    if r["uid"] in seen:
        continue
    seen.add(r["uid"]); uniq.append(r)
json.dump(uniq, open(os.environ.get("BENCH_POOL", "/tmp/pool.json"), "w"))
th = sum(1 for r in uniq if THAI.search(r["text"]))
print(f"  pool: {len(uniq)} docs — {th} containing Thai, {len(uniq)-th} not")
