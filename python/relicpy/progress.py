"""Mirror of src/progress.ts — a terminal repaints one line with \\r; a pipe gets throttled lines."""

from __future__ import annotations

import sys
import time


def _is_tty(sink) -> bool:
    isatty = getattr(sink, "isatty", None)
    try:
        return bool(isatty and isatty())
    except ValueError:
        return False


class Progress:
    def __init__(self, sink=None, every_s: float = 5.0, width: int = 96):
        self.sink = sink if sink is not None else sys.stderr
        self.every_s = every_s
        self.width = width
        self._drew = False
        self._last_at = float("-inf")
        self._last_bucket = -1

    def tick(self, msg: str, pct: float | None = None, force: bool = False) -> None:
        if _is_tty(self.sink):
            self.sink.write("\r" + msg)
            self._drew = True
            return
        now = time.monotonic()
        bucket = self._last_bucket if pct is None else int(pct // 10)
        if not force and now - self._last_at < self.every_s and bucket == self._last_bucket:
            return
        self._last_at = now
        self._last_bucket = bucket
        self.sink.write(msg.rstrip() + "\n")

    def clear(self) -> None:
        if _is_tty(self.sink) and self._drew:
            self.sink.write("\r" + " " * self.width + "\r")
        self._drew = False
