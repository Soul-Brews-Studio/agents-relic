"""ONE clock for display. Storage is UTC; display is local.

The reference shipped a bug where `session` sliced the stored ISO string while `dig`
converted it, so the same session reported 10:06 and 17:06. Every formatter in both
implementations goes through here.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Union

Stamp = Union[str, int, float, None]


def _dt(v: Stamp) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return datetime.fromtimestamp(v / 1000 if v > 1e11 else v).astimezone()
    try:
        return datetime.fromisoformat(str(v).replace("Z", "+00:00")).astimezone()
    except ValueError:
        return None


def local_date_time(v: Stamp) -> str:
    d = _dt(v)
    return d.strftime("%Y-%m-%d %H:%M") if d else ""


def local_time(v: Stamp) -> str:
    d = _dt(v)
    return d.strftime("%H:%M") if d else ""


def local_date(v: Stamp) -> str:
    d = _dt(v)
    return d.strftime("%Y-%m-%d") if d else ""


def zone_offset() -> str:
    off = datetime.now().astimezone().utcoffset()
    if off is None:
        return "+00:00"
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    h, m = total // 3600, (total % 3600) // 60
    # Minutes are OMITTED when zero — "+07", not "+07:00". Matching the reference
    # exactly, because this string lands in rendered output that is diffed against it.
    return f"{sign}{h:02d}:{m:02d}" if m else f"{sign}{h:02d}"
