"""A directory the walk could not read, said out loud (#99). Mirrors src/unreadable.ts.

Every walker used to answer a failed scandir or stat with an empty list, so an
unreadable directory looked exactly like an empty one: `relic pending` reported
"0 missing" because the walk never saw the files it would have called missing.

ENOENT STAYS QUIET. The walkers probe optional paths all the time — most session
directories have no `subagents/` — and a file can vanish between scandir and stat on a
live tree. Anything else (EACCES, EIO, ENOTDIR, ELOOP) is a real failure and gets one
stderr line per path per process. A path BENEATH one already reported gets none: it is
the same failure again.

Two kinds, both of which drop data:

    dir-unreadable   a directory could not be listed or reached — nothing under it is seen
    walk-error       one file could not be stat'ed — that file is skipped
"""

from __future__ import annotations

import errno
import os
import sys
from datetime import datetime, timezone

WALK_RULES = ("dir-unreadable", "walk-error")

# Printing is once per PROCESS; the collection is per WALK — discover() starts a fresh
# one, so a report built after it counts this walk's failures even when an earlier call
# in the same process already printed them. See src/unreadable.ts.
_printed: set[str] = set()
_collected: dict[str, dict] = {}

# Past this many lines stderr is a flood, not a warning. The collection keeps every one.
MAX_LINES = 20


def _covered(seen, path: str) -> bool:
    """Is `path`, or any directory above it, in `seen`?"""
    p = path
    while True:
        if p in seen:
            return True
        up = os.path.dirname(p)
        if up == p:
            return False
        p = up


def _describe(err: BaseException) -> str:
    """"EACCES: Permission denied" — the code and reason, without the path it repeats."""
    if isinstance(err, OSError) and err.errno:
        return f"{errno.errorcode.get(err.errno, err.errno)}: {err.strerror}"
    return f"{type(err).__name__}: {err}"


def _report(rule: str, path: str, err: BaseException) -> None:
    if isinstance(err, FileNotFoundError):
        return
    if _covered(_collected, path):
        return
    error = _describe(err)
    _collected[path] = {"rule": rule, "path": path, "error": error,
                        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                              .replace("+00:00", "Z")}
    if _covered(_printed, path):
        return
    _printed.add(path)
    if len(_printed) > MAX_LINES + 1:
        return
    print("relic: more paths could not be read — not listing each one "
          "(an index run records them all: relic skipped --files)"
          if len(_printed) > MAX_LINES else f"relic: cannot read {path}: {error}",
          file=sys.stderr)


def dir_unreadable(path: str, err: BaseException) -> None:
    """A scandir that failed: everything under `path` is invisible to this walk."""
    _report("dir-unreadable", path, err)


def walk_error(path: str, err: BaseException) -> None:
    """A stat that failed: this one file is skipped."""
    _report("walk-error", path, err)


def reachable(path: str) -> bool:
    """os.path.exists, minus the silence — it answers False for EACCES exactly as it does
    for ENOENT, so a session directory with no search permission hid its whole
    `subagents/` tree behind what read as "this session has no subagents"."""
    try:
        os.stat(path)
        return True
    except OSError as e:
        dir_unreadable(path, e)
        return False


def begin_walk() -> None:
    """Start a fresh collection. discover() calls this, so what follows describes one walk."""
    _collected.clear()


def walk_failures() -> list[dict]:
    """Every failure since begin_walk(), each path once — for reports and the proof log."""
    return list(_collected.values())
