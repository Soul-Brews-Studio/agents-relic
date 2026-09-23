"""What each model costs to run, timed apart from the ranking runs.

bench_emb.py records throughput as it goes, and on 2026-09-23 it went at a load average
in the hundreds (other agents' test suites, a PM2 daemon piling up `ps` children), which
measures the machine more than the model. Rankings do not depend on load; timings do.
So cost is timed here on its own, with the load average printed on every row: rerun it
on a quiet machine and replace the rows, without re-running a single ranking.

    load     SentenceTransformer(...) from a warm cache. Paid once per process: relic's
             embed_server keeps one process for a whole backfill, a CLI search would
             pay it every time.
    docs/s   the first BENCH_COST_DOCS pool documents (default 600), cut at 2,000 chars
             as `relic embed` cuts them, at BENCH_BATCH.
    1 query  median of 50 single-query encodes after a warm-up — what an interactive
             search pays per query, before the scan (storage.py).

A row is only TAKEN while the 1-minute load average is under BENCH_MAX_LOAD (60). Above
it the script waits, up to BENCH_LOAD_WAIT seconds (default 900), and a row that never
gets a quiet window prints as not taken rather than as a slow model.
"""
import json
import os
import sys
import time
import warnings

warnings.filterwarnings("ignore")
import numpy as np
from bench_models import BATCH, load, pick, runtime

N = int(os.environ.get("BENCH_COST_DOCS", "600"))
texts = [x[:2000] for x in json.load(open(os.environ.get("BENCH_DOCS", "/tmp/bench_docs.json")))["texts"][:N]]
queries = json.load(open(os.environ.get("BENCH_QUERIES", "/tmp/queries.json")))[:50]

print(f"  {N} docs cut at 2,000 chars, batch {BATCH}; 50 single queries; device mps\n")
print(f"  {'model':<26} {'rt':<6} {'dim':>5} {'load':>7} {'docs/s':>7} {'1 query':>8}   {'load avg':>9}")
print("  " + "-" * 77)
MAX_LOAD = float(os.environ.get("BENCH_MAX_LOAD", "60"))
WAIT = float(os.environ.get("BENCH_LOAD_WAIT", "900"))


def quiet() -> bool:
    """Wait for a 1-min load under MAX_LOAD; False if it never comes within WAIT."""
    t0 = time.time()
    while os.getloadavg()[0] >= MAX_LOAD:
        if time.time() - t0 > WAIT:
            return False
        time.sleep(15)
    return True


for label, name, qpre, dpre in pick(os.environ.get("BENCH_MODELS")):
    if not quiet():
        print(f"  {label:<26} not taken: load {os.getloadavg()[0]:.0f} >= {MAX_LOAD:.0f} for {WAIT:.0f}s")
        continue
    la = os.getloadavg()[0]
    t0 = time.time()
    try:
        m = load(name)
    except Exception as e:
        print(f"  {label:<26} unavailable ({str(e)[:50]})")
        continue
    load_s = time.time() - t0
    m.encode([dpre + x for x in texts[:BATCH]], batch_size=BATCH, show_progress_bar=False)
    t0 = time.time()
    D = m.encode([dpre + x for x in texts], normalize_embeddings=True,
                 batch_size=BATCH, show_progress_bar=False)
    docs_s = len(texts) / (time.time() - t0)
    for q in queries[:3]:
        m.encode([qpre + q["q"]], normalize_embeddings=True, show_progress_bar=False)
    one = []
    for q in queries:
        t0 = time.time()
        m.encode([qpre + q["q"]], normalize_embeddings=True, show_progress_bar=False)
        one.append((time.time() - t0) * 1000)
    lb = os.getloadavg()[0]
    flag = "" if max(la, lb) < MAX_LOAD else f"   load crossed {MAX_LOAD:.0f}: do not quote"
    print(f"  {label:<26} {runtime(name):<6} {D.shape[1]:>5} {load_s:>6.1f}s {docs_s:>7.0f} {np.median(one):>6.1f}ms"
          f"   {la:>4.0f}->{lb:<4.0f}{flag}", flush=True)
    del m, D
