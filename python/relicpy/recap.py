"""What HAPPENED in one session, as a projection of indexed rows.

`relic session <id>` answers "what shape is this session" — transcripts, tiers, counts,
the tree. It says nothing about CONTENT, so answering "what did that session actually
do" meant reading a multi-megabyte transcript. This is the missing half, and it needs no
summarisation: the index already holds the human's turns, the tool calls and the closing
message. A recap is a query, not a generation.

MAIN TIER ONLY by default. A session's subagents restate its instructions and talk to
themselves; including them buries the human's thread, which is the one thing a recap is
for. `all_tiers` gets them back.
"""

from __future__ import annotations

import re
from typing import Optional

from .query import name_of, pick_shards, resolve_session
from .store import LanceStore
from .types import is_host_preamble

_TOOL = re.compile(r"^\[tool_use ([\w.:-]+)\]")
_FILE = re.compile(r'"file_path"\s*:\s*"([^"]+)"')

# Turns that are the HOST talking, not the human. Measured on one real session: 63
# user-channel turns, 55 of them harness. Each filter added revealed the next shape, so
# this list is evidence rather than design. Mirrors src/recap.ts — both suites assert
# the same inputs.
_HARNESS = [
    re.compile(r"^<command-(message|name|args)>"),
    re.compile(r"^Base directory for this skill:"),
    re.compile(r"^<local-command-(caveat|stdout)>"),
    re.compile(r"^Caveat: The messages below were generated"),
    re.compile(r"^<system-reminder>"),
    re.compile(r"^<task-notification>"),
    re.compile(r"^This session is being continued from a previous conversation"),
]
# Anchored BOTH ends: a human elaborating on the resume prompt is a real instruction.
_RESUME = re.compile(r"^Continue from where you left off\.?$")


def is_harness_turn(text: str) -> bool:
    t = str(text or "")
    if is_host_preamble(t):
        return True
    if _RESUME.match(t.strip()):
        return True
    return any(rx.match(t) for rx in _HARNESS)


def _clean(t: str) -> str:
    return re.sub(r"\s+", " ", str(t or "")).strip()


def session_recap(id_or_prefix: str, scope, limit: Optional[int] = None,
                  all_tiers: bool = False, chars: int = 140) -> Optional[dict]:
    found = resolve_session(id_or_prefix, scope)
    rows = (found or {}).get("rows") or []
    if not rows:
        return None
    parent = next((r for r in rows if r.get("tier") == "session"), rows[0])
    uuid = str(parent.get("session_uuid") or "")

    events: list[dict] = []
    for sh in pick_shards(scope):
        try:
            where = f"session_uuid = '{uuid}'" + ("" if all_tiers else " AND tier = 'session'")
            events.extend(LanceStore.open(sh.dir).events_where(where))
        except Exception:
            continue          # a shard mid-write can throw; skip rather than abort
    if not events:
        return None
    events.sort(key=lambda e: float(e.get("seq") or 0))

    roles: dict[str, int] = {}
    tools: dict[str, int] = {}
    files: dict[str, int] = {}
    asked: list[dict] = []
    omitted = 0
    ended = ""
    for e in events:
        role, text = str(e.get("role") or "?"), str(e.get("text") or "")
        roles[role] = roles.get(role, 0) + 1
        if role == "user":
            if is_harness_turn(text):
                omitted += 1
                continue
            asked.append({"ts": str(e.get("ts") or ""), "text": _clean(text)[:chars]})
        elif role == "tool_use":
            m = _TOOL.match(text)
            if m:
                tools[m.group(1)] = tools.get(m.group(1), 0) + 1
            if re.match(r"^\[tool_use (Edit|Write|MultiEdit|NotebookEdit)\]", text):
                fm = _FILE.search(text)
                if fm:
                    files[fm.group(1)] = files.get(fm.group(1), 0) + 1
        elif role == "assistant":
            c = _clean(text)
            if c:
                ended = c[:400]          # last wins — events are seq-ordered

    desc = lambda d: [{"name": k, "n": v} for k, v in sorted(d.items(), key=lambda kv: -kv[1])]
    return {
        "sessionUuid": uuid,
        "name": name_of({"title": parent.get("title"), "description": parent.get("description")}),
        "repo": str((found or {}).get("repo") or parent.get("repo_key") or ""),
        "bank": str(parent.get("bank") or ""),
        "startedAt": str(parent.get("started_at") or ""),
        "endedAt": str(parent.get("ended_at") or ""),
        "model": str(parent.get("model") or ""),
        "gitBranch": str(parent.get("git_branch") or ""),
        "transcripts": len(rows), "events": len(events),
        "roles": [{"role": k, "n": v} for k, v in sorted(roles.items(), key=lambda kv: -kv[1])],
        "asked": asked[:limit] if limit else asked,
        "askedOmitted": omitted,
        "tools": desc(tools)[:12],
        "files": [{"path": k, "n": v} for k, v in sorted(files.items(), key=lambda kv: -kv[1])][:12],
        "endedWith": ended,
    }
