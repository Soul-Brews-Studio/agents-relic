"""Vector storage and scan cost per 1M events at each dim, on relic's own `vectors` schema.

dim x 4 bytes is the floor, not the answer: every row also carries uid, model, dim,
norm and embedded_at, plus Lance's own framing. So each dim is written as a real table
with relic's VectorRow schema (vector_row_model) and measured on disk.

The scan column is what a `--semantic` query pays at that size. relic builds no ANN
index on `vectors` (src/store/lance.ts: query().nearestTo(vec)), so every query reads
every embedding; the flat search is timed on N rows and scaled linearly to 1M.

The vectors are random unit vectors, not the pool's: float32 does not compress, so the
bytes do not depend on the values, and this way the measurement needs no private data
and reruns anywhere. Written to a temp dir and deleted.
"""
import os
import shutil
import sys
import tempfile
import time

import numpy as np
import pyarrow as pa

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
import lancedb
from relicpy.models import vector_row_model

N = int(os.environ.get("BENCH_STORAGE_ROWS", "200000"))
rng = np.random.default_rng(3)
at = time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime())

print(f"  {N:,} rows per dim, relic's VectorRow schema, float32, no ANN index"
      f"   load {os.getloadavg()[0]:.0f}\n")
print(f"  {'dim':>5} {'B/row':>7} {'floor':>7} {'on disk per 1M':>15}   {'flat top-20':>12} {'x 1M/N':>10}")
print("  " + "-" * 64)
for dim in (384, 768, 1024):
    d = tempfile.mkdtemp(prefix="relic-vec-")
    try:
        v = rng.standard_normal((N, dim)).astype(np.float32)
        v /= np.linalg.norm(v, axis=1, keepdims=True)
        schema = vector_row_model(dim).to_arrow_schema()
        cols = {"uid": pa.array([f"{i:040x}" for i in range(N)]),
                "embedding": pa.FixedSizeListArray.from_arrays(pa.array(v.ravel()), dim),
                "model": pa.array(["st:BAAI/bge-m3"] * N), "dim": pa.array([float(dim)] * N),
                "norm": pa.array(["l2"] * N), "embedded_at": pa.array([at] * N)}
        t = lancedb.connect(d).create_table(
            "vectors", data=pa.table([cols[f.name] for f in schema], schema=schema))
        size = sum(os.path.getsize(os.path.join(r, f)) for r, _, fs in os.walk(d) for f in fs)
        qs = rng.standard_normal((23, dim)).astype(np.float32)
        ms = []
        for i, q in enumerate(qs):
            t0 = time.perf_counter()
            t.search(q).limit(20).to_list()
            if i >= 3:                       # the first reads come off disk, not cache
                ms.append((time.perf_counter() - t0) * 1000)
    finally:
        shutil.rmtree(d, ignore_errors=True)
    per, scan = size / N, float(np.median(ms))
    print(f"  {dim:>5} {per:>7,.0f} {dim * 4:>7,} {per * 1e6 / 2**30:>11.2f} GiB"
          f"   {scan:>9.0f} ms {scan * 1e6 / N / 1000:>8.1f} s")
