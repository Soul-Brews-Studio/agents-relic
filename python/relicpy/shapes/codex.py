"""Codex CLI rollouts — ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl.

A DIFFERENT SHAPE, not a rename. Only `response_item` records are transcript;
`event_msg` and `token_usage_record` are UI noise and are counted, never indexed.
"""

from __future__ import annotations

import json
import os
import re

from ..models import ParsedEvent, ParsedFile
from ..types import as_obj, s, truncate, uid_of


def parse(file_path: str) -> ParsedFile:
    file_key = os.path.basename(file_path)
    events: list[ParsedEvent] = []
    lines = bad_lines = seq = 0
    cwd = model = None
    # Fallback identity: a rollout truncated before its session_meta line still needs
    # a stable id.
    session_uuid = re.sub(r"\.jsonl$", "", re.sub(r"^rollout-", "", file_key))
    started_at = ended_at = description = None

    def push(role: str, text: str, ts, part_idx: int) -> None:
        nonlocal description
        t = (text or "").strip()
        if not t:
            return
        if not description and role == "user":
            description = truncate(t, 200)
        # seq * 1000 + partIdx: one line can carry several content parts, and each
        # needs its own uid. The multiplier is the ceiling on parts per line.
        events.append(ParsedEvent(uid=uid_of("codex", file_key, seq * 1000 + part_idx),
                                  seq=seq, role=role, ts=ts, text=truncate(t)))

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
            ts = s(rec.get("timestamp"))
            if ts:
                if not started_at:
                    started_at = ts
                ended_at = ts

            payload = as_obj(rec.get("payload"))
            if not payload:
                continue

            if typ == "session_meta":
                session_uuid = s(payload.get("id")) or s(payload.get("session_id")) or session_uuid
                cwd = s(payload.get("cwd")) or cwd
                continue
            if typ == "turn_context":
                model = model or s(payload.get("model"))
                cwd = cwd or s(payload.get("cwd"))
                continue
            if typ != "response_item":
                continue

            ptype = s(payload.get("type"))
            if ptype in ("message", "agent_message"):
                role = "assistant" if ptype == "agent_message" else (s(payload.get("role")) or "unknown")
                content = payload.get("content")
                if isinstance(content, list):
                    for i, raw in enumerate(content):
                        item = as_obj(raw)
                        t = (s(item.get("text")) or "") if item else ""
                        if t:
                            push(role, t, ts, i)
                else:
                    push(role, s(payload.get("message")) or s(payload.get("text")) or "", ts, 0)
            elif ptype == "reasoning":
                # Codex emits reasoning as its own record type. Kept as a distinct role
                # so it can be searched — or excluded — separately.
                parts = []
                summary = payload.get("summary")
                if isinstance(summary, list):
                    for raw in summary:
                        item = as_obj(raw)
                        t = (s(item.get("text")) or "") if item else ""
                        if t:
                            parts.append(t)
                push("reasoning", "\n".join(parts), ts, 0)
            elif ptype in ("custom_tool_call", "function_call"):
                name = s(payload.get("name")) or "tool"
                inp = s(payload.get("input")) or s(payload.get("arguments")) or ""
                push("tool_use", f"[tool_call {name}] {truncate(inp, 2000)}", ts, 0)
            elif ptype in ("custom_tool_call_output", "function_call_output"):
                push("tool_result", f"[tool_output] {truncate(s(payload.get('output')) or '', 4000)}", ts, 0)

    # Codex rollouts carry no title record — the caller falls back to description.
    return ParsedFile(session_uuid=session_uuid, cwd=cwd, model=model, events=events,
                      lines=lines, bad_lines=bad_lines, started_at=started_at,
                      ended_at=ended_at, description=description, title=None, git_branch=None)
