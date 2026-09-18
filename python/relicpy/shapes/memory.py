"""Claude Code's own memory store — `~/.claude/projects/<encoded>/memory/*.md`.

A THIRD kind of thing, distinct from the two relic already holds:

    transcript   what was said, in order, with turns
    vault note   a document someone wrote
    memory       a single durable FACT the agent chose to keep, typed, with a pointer
                 back to the session that produced it

That pointer (`originSessionId`) is why this is worth indexing separately: it JOINS a
memory to the session that created it, which no other source can answer.

MEMORY.md is skipped by the walker: it is an index OF the others, so indexing it
repeats every memory's description as a second, lower-quality hit.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from ..models import ParsedEvent, ParsedFile
from ..types import truncate, uid_of

TYPES = {"project", "feedback", "reference", "user"}

_FIELD = re.compile(r"^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$")


def front_matter(text: str) -> tuple[dict[str, str], str]:
    """Flat `key: value`, plus the one nested block Claude Code writes (`metadata:`).

    Not a YAML parser, for the same reason as the vault shape. Nested keys are
    flattened to their own name only (`type`, `originSessionId`), unambiguous here
    because the only nesting is under `metadata:`.
    """
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text
    fields: dict[str, str] = {}
    for line in text[3:end].split("\n"):
        m = _FIELD.match(line)
        if not m:
            continue
        v = re.sub(r"^[\"']|[\"']$", "", m.group(2).strip())
        if v:
            fields[m.group(1)] = v
    body = re.sub(r"^\n+", "", text[end + 4:])
    return fields, body


def _iso(ms_source) -> str:
    return datetime.fromtimestamp(ms_source, timezone.utc)\
        .isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _cwd_from_origin(session_id: str) -> str | None:
    """The cwd of the session that produced this memory, or None.

    Falls back to None (shard `_unresolved`) rather than guessing, which is the honest
    outcome for a memory whose origin session has been pruned. Imported lazily because
    seek reaches back into the source registry, and the registry imports this module.
    """
    if not session_id:
        return None
    try:
        from ..seek import cwd_of_file, seek_on_disk
        found = seek_on_disk(session_id)
        parent = next((f for f in found if f.tier == "session"), None) or (found[0] if found else None)
        return cwd_of_file(parent.path) if parent else None
    except Exception:
        return None


def parse(file_path: str) -> ParsedFile:
    name = os.path.basename(file_path)[:-3] if file_path.endswith(".md") else os.path.basename(file_path)
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        text = ""

    fields, body = front_matter(text)
    typ = fields.get("type", "") if fields.get("type") in TYPES else ""
    origin = fields.get("originSessionId", "")

    # `modified` is the agent's own record of when it last revised the fact; file mtime
    # is only a fallback, because a copy or a checkout rewrites mtime and not the fact.
    ts = ""
    if fields.get("modified"):
        from .vault import _parse_date
        ts = _parse_date(fields["modified"]) or ""
    if not ts:
        try:
            ts = _iso(os.path.getmtime(file_path))
        except OSError:
            ts = ""

    cwd = _cwd_from_origin(origin)

    # The description is the retrieval surface Claude Code itself uses to decide
    # relevance, so it LEADS the indexed text rather than being dropped as metadata.
    head = " ".join(x for x in [fields.get("description"), f"[{typ}]" if typ else ""] if x)
    full = "\n\n".join(x for x in [head, body.strip()] if x)

    events = [ParsedEvent(uid=uid_of("memory", file_path, 0), seq=0, role="memory",
                          ts=ts, text=truncate(full))]

    return ParsedFile(
        session_uuid=fields.get("name") or name, cwd=cwd, model=None, events=events,
        lines=len(text.split("\n")), bad_lines=0, started_at=ts, ended_at=ts,
        description=fields.get("description") or body.strip()[:200] or None,
        title=fields.get("name") or name, git_branch=None,
        mem_type=typ, origin_session_id=origin,
    )
