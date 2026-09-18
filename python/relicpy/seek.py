"""Finding ONE session on disk, by id, without the index.

This is what makes `relic session <id>` answer for a session that was never imported:
seek it, import it, then answer. The alternative — "run index first" — is a worse
answer to a question the tool can resolve itself.
"""

from __future__ import annotations

import json
import os
from typing import Optional

from .discover import Found, _dirs, _files, _stat
from .sources import bank_of, load_sources

_cwd_cache: dict[str, Optional[str]] = {}


def cwd_of_file(file_path: str) -> Optional[str]:
    """The cwd a transcript records for itself, read from its head.

    Never decoded from the directory name: the encoding maps BOTH "/" and "." to "-",
    so it is lossy and not reversible. Reads a bounded prefix because a transcript can
    be tens of megabytes and the cwd is on an early line.
    """
    if file_path in _cwd_cache:
        return _cwd_cache[file_path]
    found = None
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(262_144)
        for line in head.split("\n"):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue          # a truncated final line is expected when slicing
            cwd = rec.get("cwd") or (rec.get("payload") or {}).get("cwd") \
                if isinstance(rec, dict) else None
            if isinstance(cwd, str) and cwd:
                found = cwd
                break
    except OSError:
        pass
    _cwd_cache[file_path] = found
    return found


def seek_on_disk(session_id: str) -> list[Found]:
    """Every transcript file whose name starts with `session_id`, across every
    TRANSCRIPT source.

    Gated to transcript layouts: `claude-memory` points at the SAME directory as
    `claude-live`, so without the gate every session id matches a second time, is
    parsed by the memory shape, and lands as a bogus one-event row in the memory bank.
    """
    out: list[Found] = []
    for src in load_sources():
        if not os.path.exists(src.path):
            continue
        if src.walk not in ("claude-tiers", "flat", "omp"):
            continue
        # The same bank the bulk walker would have stamped. Without it an on-demand
        # import writes into the fallback bank instead of the source's own.
        bank = bank_of(src)

        if src.walk == "claude-tiers":
            for project in _dirs(src.path):
                pdir = os.path.join(src.path, project)
                for f in _files(pdir):
                    if not f.startswith(session_id):
                        continue
                    st = _stat(os.path.join(pdir, f))
                    if st:
                        out.append(Found(os.path.join(pdir, f), project, "session", src.key,
                                         bank, None, None, st[0], st[1], src.parser))
                for sdir in _dirs(pdir):
                    if not sdir.startswith(session_id):
                        continue
                    subagents = os.path.join(pdir, sdir, "subagents")
                    for f in _files(subagents):
                        st = _stat(os.path.join(subagents, f))
                        if st:
                            out.append(Found(os.path.join(subagents, f), project, "subagent",
                                             src.key, bank, None, f[:-6], st[0], st[1], src.parser))
                    workflows = os.path.join(subagents, "workflows")
                    for run in _dirs(workflows):
                        if not run.startswith("wf_"):
                            continue
                        for f in _files(os.path.join(workflows, run)):
                            if f == "journal.jsonl":
                                continue
                            p = os.path.join(workflows, run, f)
                            st = _stat(p)
                            if st:
                                out.append(Found(p, project, "workflow_agent", src.key, bank,
                                                 run, f[:-6], st[0], st[1], src.parser))
        else:
            stack = [src.path]
            depth = 0
            while stack and depth < 6:
                nxt = []
                for d in stack:
                    for f in _files(d):
                        if session_id not in f:
                            continue
                        st = _stat(os.path.join(d, f))
                        if st:
                            out.append(Found(os.path.join(d, f), src.key, "session", src.key,
                                             bank, None, None, st[0], st[1], src.parser))
                    nxt.extend(os.path.join(d, x) for x in _dirs(d))
                stack = nxt
                depth += 1
    return out
