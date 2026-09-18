"""omp (Oh My Pi) — ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl."""

from __future__ import annotations

import json
import os
import re

from ..models import ParsedEvent, ParsedFile
from ..types import _compact_json, as_obj, s, truncate, uid_of

INDEXED = {"user", "assistant", "toolResult"}


def _flatten_omp(content) -> tuple[str, str | None]:
    """Same "label by what the block actually is" rule as Claude.

    A content array holding ONLY toolCall/thinking blocks is tool traffic or reasoning,
    not conversation, whichever envelope role carried it.
    """
    if not isinstance(content, list):
        return "", None
    kinds, out = set(), []
    for raw in content:
        item = as_obj(raw)
        if not item:
            continue
        t = s(item.get("type"))
        if t:
            kinds.add(t)
        if t == "text":
            txt = s(item.get("text"))
            if txt:
                out.append(txt)
        elif t == "thinking":
            th = s(item.get("thinking"))
            if th:
                out.append(th)
        elif t == "toolCall":
            name = s(item.get("name")) or "?"
            out.append(f"[tool_use {name}] {truncate(_compact_json(item.get('arguments') or {}), 2000)}")
    role = None
    if "toolCall" in kinds and "text" not in kinds:
        role = "tool_use"
    elif kinds == {"thinking"}:
        role = "thinking"
    return "\n".join(out), role


def parse(file_path: str) -> ParsedFile:
    file_key = os.path.basename(file_path)
    events: list[ParsedEvent] = []
    lines = bad_lines = seq = 0
    cwd = model = title = None
    session_uuid = re.sub(r"\.jsonl$", "", file_key)
    started_at = ended_at = description = None

    with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
        for line in fh:
            trimmed = line.strip()
            if not trimmed:
                continue
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
            if typ == "session":
                if not cwd:
                    cwd = s(rec.get("cwd"))
                sid = s(rec.get("id"))
                if sid:
                    session_uuid = sid
            if typ == "model_change" and not model:
                model = s(rec.get("model"))
            if typ in ("title", "title_change") and not title:
                t = s(rec.get("title"))
                if t:
                    title = t

            ts = s(rec.get("timestamp"))
            if ts:
                if not started_at:
                    started_at = ts
                ended_at = ts

            msg = as_obj(rec.get("message"))
            envelope_role = (s(msg.get("role")) if msg else None)
            gate = envelope_role or "" if typ == "message" else ""
            if gate not in INDEXED:
                continue
            if not envelope_role:
                continue

            text, brole = _flatten_omp(msg.get("content") if msg else None)
            if not text:
                continue
            role = brole or ("tool_result" if envelope_role == "toolResult" else envelope_role)

            if not description and role == "user":
                description = truncate(text, 200)
            events.append(ParsedEvent(uid=uid_of("omp", file_key, seq), seq=seq,
                                      role=role, ts=ts, text=truncate(text)))

    return ParsedFile(session_uuid=session_uuid, cwd=cwd, model=model, events=events,
                      lines=lines, bad_lines=bad_lines, started_at=started_at,
                      ended_at=ended_at, description=description, title=title, git_branch=None)
