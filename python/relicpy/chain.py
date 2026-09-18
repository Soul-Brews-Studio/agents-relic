"""A session's tree on a TIME axis — what ran sequentially, what ran in parallel.

`session --tree` shows the shape of the directory; this shows the shape of the clock.
Nine agents in one workflow run look identical in a listing whether they ran together
or one after another; only the axis separates them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Optional

from .time import local_date, local_time, zone_offset


def _ms(s: Optional[str]) -> int:
    if not s:
        return 0
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return 0


@dataclass
class ChainGroup:
    run: str                    # workflow run id, "subagents", or "session"
    rows: list[dict]
    start_ms: int
    end_ms: int
    peak: int                   # max simultaneously running


@dataclass
class Chain:
    id: str
    total: int
    start_ms: int
    end_ms: int
    groups: list[ChainGroup]
    wall_ms: int                # span from first start to last end
    work_ms: int                # summed durations — exceeds wall when work overlapped


def peak_concurrency(rows: list[dict]) -> int:
    """Max rows running at the same instant — the REAL parallelism.

    An edge sweep, not a max-per-bucket: two agents that overlap for one second are
    concurrent, and any bucketing wide enough to be cheap would miss it.
    """
    edges: list[tuple[int, int]] = []
    for r in rows:
        a, b = _ms(r.get("started_at")), _ms(r.get("ended_at"))
        if not a:
            continue
        edges.append((a, 1))
        edges.append((max(b, a), -1))
    edges.sort(key=lambda e: (e[0], e[1]))
    cur = peak = 0
    for _, d in edges:
        cur += d
        peak = max(peak, cur)
    return peak


def build_chain(ident: str, all_rows: list[dict]) -> Chain:
    # A workflow directory also holds journal.jsonl — bookkeeping with no events and no
    # clock. Left in, it renders as a zero-length bar at the axis origin in every group.
    rows = [r for r in all_rows if int(r.get("event_count") or 0) > 0 and r.get("started_at")]
    if not rows:
        return Chain(ident, 0, 0, 0, [], 0, 0)

    groups: dict[str, list[dict]] = {}
    for r in rows:
        # A workflow run is a unit of INTENT: one fan-out, N agents. Subagents spawned
        # directly share a bucket because they have no run to belong to.
        key = r.get("workflow_run_id") or ("session" if r.get("tier") == "session" else "subagents")
        groups.setdefault(key, []).append(r)

    out: list[ChainGroup] = []
    for run, gr in groups.items():
        gr.sort(key=lambda r: _ms(r.get("started_at")))
        starts = [x for x in (_ms(r.get("started_at")) for r in gr) if x]
        ends = [x for x in (max(_ms(r.get("ended_at")), _ms(r.get("started_at"))) for r in gr) if x]
        out.append(ChainGroup(run, gr, min(starts), max(ends), peak_concurrency(gr)))
    out.sort(key=lambda g: g.start_ms)

    all_starts = [x for x in (_ms(r.get("started_at")) for r in rows) if x]
    all_ends = [x for x in (max(_ms(r.get("ended_at")), _ms(r.get("started_at"))) for r in rows) if x]
    start_ms, end_ms = min(all_starts), max(all_ends)
    work_ms = sum(max(_ms(r.get("ended_at")), _ms(r.get("started_at"))) - _ms(r.get("started_at"))
                  for r in rows if _ms(r.get("started_at")))
    return Chain(ident, len(rows), start_ms, end_ms, out, end_ms - start_ms, work_ms)


def _dur(msv: int) -> str:
    s = round(msv / 1000)
    if s < 90:
        return f"{s}s"
    m = round(s / 60)
    return f"{m}m" if m < 90 else f"{m/60:.1f}h"


def _bar(start_ms: int, end_ms: int, t0: int, t1: int, width: int) -> str:
    """One bar on a SHARED axis, so bars in a group are comparable to each other."""
    span = max(1, t1 - t0)
    a = round(((start_ms - t0) / span) * (width - 1))
    b = round(((end_ms - t0) / span) * (width - 1))
    a = max(0, min(width - 1, a))
    b = max(a, min(width - 1, b))
    body = "▬" * (b - a + 1) if b > a else "▪"
    return " " * a + body + " " * max(0, width - a - len(body))


def render_chain(c: Chain, width: int = 40, max_rows: int = 8) -> str:
    L: list[str] = []
    if not c.total:
        return f"{c.id} — no timed transcripts"
    multi_day = local_date(c.start_ms) != local_date(c.end_ms)
    L.append(f"{c.id} · {c.total} transcripts · {local_date(c.start_ms)} "
             f"{local_time(c.start_ms)} → "
             f"{local_date(c.end_ms) + ' ' if multi_day else ''}{local_time(c.end_ms)}"
             f"  (UTC{zone_offset()})")
    L.append(f"wall {_dur(c.wall_ms)} · agent-time {_dur(c.work_ms)} · "
             f"{c.work_ms / max(1, c.wall_ms):.1f}x parallel")
    L.append("")
    for g in c.groups:
        label = ("PARENT SESSION" if g.run == "session"
                 else "subagents (direct)" if g.run == "subagents" else g.run)
        L.append(f"{label}   {len(g.rows)} transcript{'' if len(g.rows) == 1 else 's'} · "
                 f"{local_time(g.start_ms)}–{local_time(g.end_ms)} · "
                 f"{_dur(g.end_ms - g.start_ms)} · peak {g.peak} at once")
        for r in g.rows[:max_rows]:
            s = _ms(r.get("started_at")) or g.start_ms
            e = max(_ms(r.get("ended_at")) or s, s)
            name = str(r.get("agent_id") or r.get("tier") or "")[:22].ljust(22)
            L.append(f"  {local_time(s)} {name} |{_bar(s, e, g.start_ms, g.end_ms, width)}| "
                     f"{_dur(e - s):>5} {int(r.get('event_count') or 0):>5}ev")
        if len(g.rows) > max_rows:
            L.append(f"  … and {len(g.rows) - max_rows} more")
        L.append(f"  {' ' * 29}{local_time(g.start_ms)}"
                 f"{'─' * max(0, width - 10)}{local_time(g.end_ms)}")
        L.append("")
    return "\n".join(L)
