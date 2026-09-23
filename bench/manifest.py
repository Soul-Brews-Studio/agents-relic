"""Fingerprint the bench inputs, so a later run can prove it scored the SAME documents.

The pool and the queries are built from one machine's private sessions and never enter
the repo. What CAN be published is their hash, and a hash is enough: a later model run
that reads the same files reproduces these sha256 values, and one that does not is
measuring a different pool, however similar its numbers look. The 2026-09-18 inputs
lived in /tmp and were gone five days later, which is why the 2026-09-23 run had to
re-run every model instead of adding three.

Writes manifest.json beside the pool (BENCH_MANIFEST overrides). Counts and hashes only,
never text. BENCH_EXTRA="path,path" fingerprints further query files.
"""
import hashlib
import json
import os
import re
import socket
import statistics
import subprocess
import sys
import time
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from relicpy.repo import list_shards

THAI = re.compile(r"[฀-๿]")
POOL = os.environ.get("BENCH_POOL", "/tmp/pool.json")
FILES = [os.environ.get("BENCH_QUERIES", "/tmp/queries.json"),
         os.environ.get("BENCH_PARA", "/tmp/queries_para.json")]
FILES += [p for p in os.environ.get("BENCH_EXTRA", "").split(",") if p]
OUT = os.environ.get("BENCH_MANIFEST", os.path.join(os.path.dirname(POOL), "manifest.json"))
GEN = os.environ.get("BENCH_GEN_MODEL", "gemma3:27b")
HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")


def sha256(path: str) -> str:
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def version(mod: str) -> str:
    try:
        return __import__(mod).__version__
    except Exception:
        return "not in this environment"


def ollama_digest(model: str) -> str:
    try:
        with urllib.request.urlopen(f"{HOST}/api/tags", timeout=10) as r:
            tags = json.loads(r.read()).get("models", [])
        return next((m["digest"] for m in tags if m["name"] == model), "not installed")
    except Exception as e:
        return f"unreachable ({type(e).__name__})"


pool = json.load(open(POOL))
uids = {r["uid"] for r in pool}
lens = [len(r["text"]) for r in pool]
thai_share = [len(THAI.findall(r["text"])) / len(r["text"]) for r in pool if THAI.search(r["text"])]
here = os.path.dirname(os.path.abspath(__file__))
head = subprocess.run(["git", "-C", here, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
dirty = bool(subprocess.run(["git", "-C", here, "status", "--porcelain", "--", "."],
                            capture_output=True, text=True).stdout.strip())
m = {
    "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "host": socket.gethostname(),
    "bench_commit": head + ("+dirty" if dirty else ""),
    "shards_visible": len(list_shards()),
    "pool": {
        "path": POOL, "sha256": sha256(POOL), "bytes": os.path.getsize(POOL),
        "docs": len(pool), "unique_uids": len(uids),
        "thai": sum(1 for r in pool if THAI.search(r["text"])),
        "roles": {k: sum(1 for r in pool if r["role"] == k) for k in sorted({r["role"] for r in pool})},
        "distinct_repos": len({r["repo_key"] for r in pool}),
        "distinct_texts": len({" ".join(r["text"].split()) for r in pool}),
        "banks": {b: sum(1 for r in pool if r.get("bank") == b)
                  for b in sorted({r.get("bank") or "?" for r in pool})},
        "chars": {"min": min(lens), "median": int(statistics.median(lens)), "max": max(lens)},
        "thai_char_share_in_thai_docs_median": round(statistics.median(thai_share), 3) if thai_share else None,
    },
    # build_pool.py's own record of how the pool was drawn: seed, sampling, cap, dedupe.
    "sampling": (json.load(open(os.path.join(os.path.dirname(POOL), "pool_manifest.json")))
                 if os.path.exists(os.path.join(os.path.dirname(POOL), "pool_manifest.json")) else "missing"),
    "queries": {},
    "generator": {"model": GEN, "ollama_digest": ollama_digest(GEN)},
    "versions": {"python": sys.version.split()[0], "lancedb": version("lancedb"),
                 "numpy": version("numpy"), "sentence_transformers": version("sentence_transformers"),
                 "transformers": version("transformers"), "torch": version("torch")},
}
for path in FILES:
    if not os.path.exists(path):
        m["queries"][os.path.basename(path)] = "missing"
        continue
    qs = json.load(open(path))
    e = {"path": path, "sha256": sha256(path), "n": len(qs),
         "thai": sum(1 for q in qs if q["thai"]),
         "thai_script_in_query": sum(1 for q in qs if THAI.search(q["q"])),
         "targets_outside_pool": sum(1 for q in qs if q["uid"] not in uids)}
    ov = [q["overlap"] for q in qs if "overlap" in q]
    if ov:
        e["overlap_median"] = round(statistics.median(ov), 4)
        e["overlap_zero"] = sum(1 for x in ov if x == 0)
    m["queries"][os.path.basename(path)] = e
json.dump(m, open(OUT, "w"), indent=2, ensure_ascii=False)

p = m["pool"]
print(f"  manifest: {OUT}")
print(f"  pool {p['sha256'][:16]}  {p['docs']} docs ({p['distinct_texts']} distinct texts), {p['thai']} Thai,"
      f" {len(p['banks'])} banks, {p['distinct_repos']} repos, {p['chars']['min']}-{p['chars']['max']} chars")
for name, e in m["queries"].items():
    if isinstance(e, dict):
        print(f"  {name:<24} {e['sha256'][:16]}  n={e['n']} thai={e['thai']}"
              f" (script {e['thai_script_in_query']})  outside pool={e['targets_outside_pool']}")
    else:
        print(f"  {name:<24} {e}")
print(f"  generator {GEN}  {m['generator']['ollama_digest'][:19]}")
