"""Claude Code transcripts — ~/.claude/projects/<encoded>/<uuid>.jsonl and its
subagent / workflow-agent children.

One JSON object per line, and the WHOLE file is transcript — unlike Codex, where only
one record type is.
"""

from __future__ import annotations

import json
import os
import re

from ..models import ParsedEvent, ParsedFile
from ..types import as_obj, block_role, flatten_content, s, truncate, uid_of

# Roles whose text is worth full-text indexing. UI/state events are counted, not indexed.
INDEXED = {"user", "assistant", "system"}

_UUID36 = re.compile(r"^[0-9a-f-]{36}$")


def parse(file_path: str) -> ParsedFile:
    file_key = os.path.basename(file_path)
    events: list[ParsedEvent] = []
    lines = bad_lines = seq = 0
    cwd = model = None
    session_uuid = re.sub(r"\.jsonl$", "", file_key)
    started_at = ended_at = description = title = git_branch = None

    with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            trimmed = line.strip()
            if not trimmed:
                continue          # seq counts NON-EMPTY lines only — see `show`
            lines += 1
            seq += 1

            try:
                rec = as_obj(json.loads(trimmed))
            except Exception:
                bad_lines += 1
                continue
            if rec is None:
                bad_lines += 1
                continue

            typ = s(rec.get("type")) or "unknown"

            # cwd comes from the session's own field, never decoded from the directory
            # name: the encoding maps BOTH "/" and "." to "-", so it is lossy.
            if not cwd:
                cwd = s(rec.get("cwd"))
            if not _UUID36.match(session_uuid):
                session_uuid = s(rec.get("sessionId")) or session_uuid

            ts = s(rec.get("timestamp"))
            if ts:
                if not started_at:
                    started_at = ts
                ended_at = ts

            if not git_branch:
                git_branch = s(rec.get("gitBranch"))
            if typ == "ai-title":
                t = s(rec.get("aiTitle"))
                if t:
                    # Overwrite, never keep-first: the record repeats on nearly every
                    # turn and the title is refined as the session goes on.
                    title = t

            if typ not in INDEXED:
                continue

            msg = as_obj(rec.get("message"))
            if not model and msg:
                model = s(msg.get("model"))
            raw = (msg.get("content") if msg else None)
            if raw is None:
                raw = rec.get("content", "")
            text = flatten_content(raw).strip()
            if not text:
                continue

            # Label by what the block ACTUALLY is, not by the envelope that carried it.
            role = block_role(raw) or (s(msg.get("role")) if msg else None) or typ

            if not description and role == "user":
                description = truncate(text, 200)
            events.append(ParsedEvent(
                uid=uid_of("claude", file_key, seq),   # path-independent by design
                seq=seq, role=role, ts=ts, text=truncate(text),
            ))

    return ParsedFile(
        session_uuid=session_uuid, cwd=cwd, model=model, events=events,
        lines=lines, bad_lines=bad_lines, started_at=started_at, ended_at=ended_at,
        description=description, title=title, git_branch=git_branch,
    )
