"""Paths a hit quotes that a temp janitor may already have deleted.

The failure this exists for is silent and expensive: relic answers "yes, this was done
before" correctly, quotes the exact output paths from the old transcript, and the caller
treats them as real. The scratch directory was cleaned up days ago. The job gets redone
from scratch, and nothing in the result hinted it would.

FLAG AT READ TIME, NEVER AT WRITE TIME. "we downloaded it to /tmp and transcoded it" is
exactly what a later session needs to find — the transcript is the record of what
happened, and an ephemeral path in it is information, not noise.

Measured on bank `projects`, 408,886 events: 23,818 (5.8%) reference an ephemeral path
— /tmp 8,653, scratchpad 7,755, claude-<pid> 7,410. One event in seventeen.

Mirrors src/ephemeral.ts exactly.
"""

from __future__ import annotations

import re
from typing import Optional

# STRUCTURAL shapes carry their own proof that a path was session-scoped:
#   /claude-<pid>/   the pid is IN the path — it cannot outlive that process
#   /scratchpad/     a directory the tooling itself creates and tears down
_STRUCTURAL = [
    (re.compile(r"/claude-\d+/"), "claude-<pid> scratch root"),
    (re.compile(r"/scratchpad/"), "scratchpad directory"),
]

# A bare /tmp prefix only CORRELATES — a session discussing /tmp as a topic, or a daemon
# configured to keep state there, both match. Anchored at a path boundary so `/tmp`
# matches, `/var/tmpfiles` does not, and the word "tmp" in prose does not.
_WEAK = [
    (re.compile(r"""(?:^|\s|["'`(=])/(?:private/)?tmp/"""), "/tmp path"),
    (re.compile(r"\$XDG_RUNTIME_DIR\b"), "$XDG_RUNTIME_DIR"),
]


def ephemeral_hint(text: str) -> Optional[dict]:
    """The strongest hint in this text, or None. Pure string work — no disk access."""
    for rx, rule in _STRUCTURAL:
        if rx.search(text):
            return {"tier": "structural", "rule": rule}
    for rx, rule in _WEAK:
        if rx.search(text):
            return {"tier": "weak", "rule": rule}
    return None


def bank_of_hit(repo_key: str) -> Optional[str]:
    """The bank out of a hit's shard key — `<bank>/github.com/<org>/<repo>`.

    A hit has NO `bank` attribute; the bank is the first segment of `repo`. Reaching
    for `h.bank` returns None and silently drops the host note on every hit — which is
    what shipped here first, and which the unit test could not catch because it passed
    the bank in directly.
    """
    head, sep, _ = repo_key.partition("/")
    return head if sep else None


def ephemeral_note(text: str, bank: Optional[str] = None) -> str:
    """One line for a hit, or "".

    Names the MACHINE the path was recorded on, because relic indexes another account's
    corpus and a second host's. A stat from the querying process is meaningless for a
    path written under a different uid on a different box — without the host a live
    check would be wrong rather than merely unhelpful. That is also why there is no
    live check here: this is pure text.
    """
    h = ephemeral_hint(text)
    if not h:
        return ""
    where = f", recorded in bank {bank}" if bank and bank != "projects" else ""
    if h["tier"] == "structural":
        return (f"  ⚠ ephemeral-path ({h['rule']}{where}) — this path was "
                "session-scoped and is probably gone")
    return f"  · possibly-ephemeral path ({h['rule']}{where})"
