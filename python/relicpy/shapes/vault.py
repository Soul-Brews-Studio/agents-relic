"""Oracle ψ vault — `<repo>/ψ/**.md`. A document, not a transcript: no turns.

Measured before this shape was built: 10,058 .md / 19 MB / 92% carrying YAML
frontmatter / 94% under 4 KB — small, structured, and worth one row per note rather
than chunking. Long notes still chunk, at heading boundaries.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone

from ..models import ParsedEvent, ParsedFile
from ..types import truncate, uid_of, utf16_len

_FIELD = re.compile(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$")


def front_matter(text: str) -> tuple[dict[str, str], str, str]:
    """Flat `key: value` only. Not a YAML parser — the format is flat enough that a
    dependency would buy nothing, and a nested/multiline value simply stays in `raw`."""
    if not text.startswith("---"):
        return {}, text, ""
    end = text.find("\n---", 3)
    if end < 0:
        return {}, text, ""
    raw = text[3:end].strip()
    body = re.sub(r"^\n+", "", text[end + 4:])
    fields: dict[str, str] = {}
    for line in raw.split("\n"):
        m = _FIELD.match(line.strip())
        if not m:
            continue
        v = re.sub(r"^[\"']|[\"']$", "", m.group(2).strip())
        if v:
            fields[m.group(1)] = v
    return fields, body, raw


def _u16_slice(text: str, start: int, end: int) -> str:
    """Slice in UTF-16 space, because the reference implementation's `.slice()` is.

    Chunk boundaries decide uid assignment (`uidOf(path, i)`), so a chunk cut one code
    unit earlier produces a different set of rows for the same file.
    """
    buf = text.encode("utf-16-le")[start * 2:end * 2]
    return buf.decode("utf-16-le", errors="ignore")


def chunk(body: str, max_len: int) -> list[str]:
    if utf16_len(body) <= max_len:
        return [body]
    out: list[str] = []
    cur = ""
    for part in re.split(r"\n(?=## )", body):
        if cur and utf16_len(cur) + utf16_len(part) > max_len:
            out.append(cur)
            cur = ""
        if utf16_len(part) > max_len:
            if cur:
                out.append(cur)
                cur = ""
            n = utf16_len(part)
            for i in range(0, n, max_len):
                out.append(_u16_slice(part, i, i + max_len))
            continue
        cur = f"{cur}\n{part}" if cur else part
    if cur:
        out.append(cur)
    return out


def _timestamp_of(fields: dict[str, str], file_path: str) -> str:
    d = fields.get("date") or fields.get("created_at") or fields.get("updated")
    if d:
        iso = _parse_date(d)
        if iso:
            return iso
    try:
        return datetime.fromtimestamp(os.path.getmtime(file_path), timezone.utc)\
            .isoformat(timespec="milliseconds").replace("+00:00", "Z")
    except OSError:
        return ""


def _parse_date(d: str) -> str | None:
    """Mirror `Date.parse` for the formats that actually appear in frontmatter."""
    for fmt in ("%Y-%m-%dT%H:%M:%S.%f%z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S",
                "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(d.replace("Z", "+0000"), fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        except ValueError:
            continue
    return None


def parse(file_path: str) -> ParsedFile:
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
            text = fh.read()
    except OSError:
        text = ""                      # unreadable -> empty note

    fields, body, raw = front_matter(text)
    ts = _timestamp_of(fields, file_path)
    title = fields.get("name") or fields.get("title") or fields.get("pattern")

    chunks = chunk(body.strip(), 15_000)
    events = [
        ParsedEvent(
            # the FULL PATH, not the basename: two oracles' vaults legitimately hold a
            # note of the same name, and they are different notes.
            uid=uid_of("vault", file_path, i), seq=i, role="note", ts=ts,
            text=truncate(f"{raw}\n\n{c}" if i == 0 and raw else c),
        )
        for i, c in enumerate(chunks)
    ]
    if not events:
        events.append(ParsedEvent(uid=uid_of("vault", file_path, 0), seq=0,
                                  role="note", ts=ts, text=raw))

    return ParsedFile(
        session_uuid=file_path, cwd=file_path, model=None, events=events,
        lines=len(text.split("\n")), bad_lines=0, started_at=ts, ended_at=ts,
        description=(fields.get("description") or body.strip()[:200]) or None,
        title=title, git_branch=None,
    )
