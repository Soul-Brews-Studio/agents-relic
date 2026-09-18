"""The query log: who answers, what is dead, and what you actually ask about.

Every search appends ONE line. That log is what turned "the index feels big" into
"340 of 345 shards have never produced a best hit" — a measurement no amount of
reasoning about the design would have produced.
"""

from __future__ import annotations

import json
import os
import statistics
from typing import Optional

from .repo import default_root


def trace_path(data_root: Optional[str]) -> str:
    return os.path.join(data_root or default_root(), "trace.jsonl")


def trace(entry: dict, data_root: Optional[str]) -> None:
    """Append one line. NEVER throws — a broken log must not break a search."""
    if os.environ.get("RELIC_NO_TRACE"):
        return
    try:
        p = trace_path(data_root)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        # A SINGLE write of one line: the fleet has two separate incidents of a JSONL
        # log corrupting under concurrent append when built from multiple writes.
        with open(p, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError:
        pass          # tracing is never worth failing a query for


def read_trace(data_root: Optional[str], known_shards: Optional[list[str]] = None) -> Optional[dict]:
    p = trace_path(data_root)
    if not os.path.exists(p):
        return None
    entries = []
    for line in open(p, encoding="utf-8"):
        if not line.strip():
            continue
        try:
            entries.append(json.loads(line))
        except Exception:
            continue          # skip a torn line
    if not entries:
        return None

    by_repo: dict[str, int] = {}
    by_filter: dict[str, int] = {}
    opened_by_repo: dict[str, int] = {}
    for e in entries:
        if e.get("top_repo"):
            by_repo[e["top_repo"]] = by_repo.get(e["top_repo"], 0) + 1
        for k in (e.get("filters") or {}):
            by_filter[k] = by_filter.get(k, 0) + 1
        if e.get("opened"):
            opened_by_repo[e.get("top_repo", "")] = opened_by_repo.get(e.get("top_repo", ""), 0) + 1
    times = sorted(int(e.get("ms") or 0) for e in entries)
    stamps = sorted(str(e.get("ts") or "") for e in entries if e.get("ts"))
    return {
        "total": len(entries),
        "opened": sum(1 for e in entries if e.get("opened")),
        "opened_by_repo": sorted(({"repo": k, "n": v} for k, v in opened_by_repo.items()),
                                 key=lambda x: -x["n"]),
        "span": f"{stamps[0][:16]} → {stamps[-1][:16]}" if stamps else "",
        "by_repo": sorted(({"repo": k, "n": v} for k, v in by_repo.items()), key=lambda x: -x["n"]),
        "by_filter": sorted(({"filter": k, "n": v} for k, v in by_filter.items()), key=lambda x: -x["n"]),
        "zero_hit": sum(1 for e in entries if not e.get("hits")),
        "fts_misses": sum(1 for e in entries if e.get("fts") is False),
        "slowest": sorted(({"q": e.get("q", ""), "ms": int(e.get("ms") or 0)} for e in entries),
                          key=lambda x: -x["ms"])[:5],
        "median_ms": int(statistics.median(times)) if times else 0,
        # Shards that have NEVER produced a best hit — the argument for indexing less.
        "dead_shards": sorted(set(known_shards or []) - set(by_repo)),
    }
