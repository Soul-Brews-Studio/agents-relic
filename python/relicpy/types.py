"""Event identity and content flattening — the two things every shape shares.

Ported from src/types.ts. The hashes produced here MUST equal the TypeScript ones
byte for byte: both implementations write into the same LanceDB tables keyed on `uid`,
so a different digest means the same event lands twice instead of merging.
"""

from __future__ import annotations

import re

import hashlib
import json
from typing import Any, Optional

MAX_TEXT = 16_000

# Unit separator — cannot occur in a path or a seq, so the join is unambiguous.
SEP = chr(31)


def uid_of(source: str, file_key: str, seq: int) -> str:
    """Event identity. Deliberately EXCLUDES the directory.

    Only the basename and the line number participate, so the same transcript found
    under two roots (live + archive, or two machines) collapses to one row.

    It hashes a LINE SLOT, not an event — which is why search dedup keys on content
    instead of uid. A resumed session writes a new file under the same uuid whose
    slot 7 holds a different event entirely.
    """
    return hashlib.sha1(SEP.join([source, file_key, str(seq)]).encode("utf-8")).hexdigest()


def as_obj(v: Any) -> Optional[dict]:
    return v if isinstance(v, dict) else None


def s(v: Any) -> Optional[str]:
    """A non-empty string, or None — the TS `str()` helper."""
    return v if isinstance(v, str) and v else None


def utf16_len(text: str) -> int:
    """Length in UTF-16 code units — what JavaScript's `.length` returns.

    Python counts CODE POINTS, JavaScript counts UTF-16 CODE UNITS, so a non-BMP
    character (any emoji) is 1 here and 2 there. Verified on a real transcript: one
    "📤" made the same event measure 315 in Python and 316 in TypeScript.
    """
    return len(text.encode("utf-16-le")) // 2


def truncate(text: str, max_len: int = MAX_TEXT) -> str:
    """Cut at the same point the TypeScript does, and count the remainder the same way.

    This is not pedantry: both implementations write into ONE index keyed on `uid`, so
    a text truncated at a different offset is a different row for the same key — the
    later writer silently overwrites the earlier one with different content.

    `text[:max_len]` would cut at max_len CODE POINTS, which drifts past the JS cut
    point by one for every emoji before it. So the slice is done in UTF-16 space.

    ONE DELIBERATE DEVIATION: JavaScript's `slice()` can cut a surrogate PAIR in half
    and emit a lone surrogate. Python cannot represent that, and reproducing it would
    mean storing invalid text to match a bug. When the cut lands mid-pair the whole
    character is dropped instead, so the result is one code unit shorter than the
    TypeScript's in that case, and valid.
    """
    if utf16_len(text) <= max_len:
        return text
    buf = text.encode("utf-16-le")[: max_len * 2]
    head = buf.decode("utf-16-le", errors="ignore")   # drops a split surrogate
    return head + f"...[+{utf16_len(text) - max_len}]"


def block_role(content: Any) -> Optional[str]:
    """What a content array actually IS, regardless of the envelope carrying it.

    Claude delivers a tool result as a `user` message whose content is a tool_result
    block, so taking the envelope role at face value files machine output as something
    the human said. Measured on one shard before this existed: 68.5% of indexed text
    was tool-output-shaped while only 3.7% carried the tool_result role.

    Returns None for ordinary prose so the caller falls back to the envelope role.
    """
    if not isinstance(content, list):
        return None
    kinds = set()
    for raw in content:
        item = as_obj(raw)
        t = s(item.get("type")) if item else None
        if t:
            kinds.add(t)
    if not kinds:
        return None
    # A block array that is ONLY tool traffic is tool traffic, whoever sent it.
    if "tool_result" in kinds and "text" not in kinds:
        return "tool_result"
    if "tool_use" in kinds and "text" not in kinds:
        return "tool_use"
    if kinds == {"thinking"}:
        return "thinking"
    return None


def _compact_json(v: Any) -> str:
    """JSON.stringify-compatible: no spaces after separators.

    Python's default `json.dumps` inserts ", " and ": ", which would make the flattened
    text differ from the TypeScript output character for character — and that text is
    what gets full-text indexed and compared.
    """
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def flatten_content(content: Any) -> str:
    """Flatten Claude/Codex content arrays into plain searchable text."""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    out: list[str] = []
    for raw in content:
        item = as_obj(raw)
        if not item:
            continue
        t = s(item.get("text"))
        if t:
            out.append(t)
            continue
        typ = s(item.get("type"))
        if typ == "tool_use":
            name = s(item.get("name")) or "?"
            out.append(f"[tool_use {name}] {truncate(_compact_json(item.get('input') or {}), 2000)}")
        elif typ == "tool_result":
            c = item.get("content")
            body = c if isinstance(c, str) else _compact_json(c if c is not None else "")
            out.append(f"[tool_result] {truncate(body, 4000)}")
        elif typ == "thinking":
            th = s(item.get("thinking"))
            if th:
                out.append(th)
    return "\n".join(out)


# Text a HOST injected as the first "user" message, which is never a session's name.
#
# Both hosts do this and only Claude's shapes were recognised, so 64% of Codex sessions
# were listed by their own boot directive. Measured over 1,750 codex sessions:
#
#   391  <recommended_plugins> Here is a list of plugins that are a...
#   365  # AGENTS.md instructions <INSTRUCTIONS> <!-- AUTONOMY DIRE...
#   358  <codex_internal_context source="goal"> Continue working to...
#    12  # AGENTS.md instructions for /opt/Code/github.com/...
#
# The AGENTS.md blob alone is 27,708 characters, stored truncated to 200 — so every one
# of those sessions was named by the same cut-off sentence, differing only in a path.
#
# ANCHORED AT THE START, deliberately: a human quoting <recommended_plugins> while
# debugging is a real message and keeps its name. Only a message that BEGINS as the
# directive is the directive.
_HOST_PREAMBLE = [
    re.compile(r"^#\s*AGENTS\.md instructions\b", re.I),
    re.compile(r"^<recommended_plugins>", re.I),
    re.compile(r"^<codex_internal_context\b", re.I),
    re.compile(r"^You have oh-my-codex installed\b", re.I),
    re.compile(r"^<INSTRUCTIONS>", re.I),
    re.compile(r"^<environment_context>", re.I),
]


def is_host_preamble(text) -> bool:
    t = str(text or "").lstrip()
    return any(rx.match(t) for rx in _HOST_PREAMBLE)


# Tags whose content later code reads: slash-command promotion and the caveat drop.
_STRUCTURAL_TAGS = {
    "command-name", "command-message", "command-args",
    "local-command-caveat", "local-command-stdout", "local-command-stderr",
}
_ENVELOPE = re.compile(r"^\s*<([a-zA-Z][\w-]*)\b[^>]*(?:>|$)")
# The channel tag itself, anywhere (from #80); `<channel-id>` in quoted CLI usage is not it.
_CHANNEL_TAG = re.compile(r"</?channel(?=[\s>])[^>]*>", re.I)


def strip_envelope(text) -> str:
    """Mirror of stripEnvelope in src/types.ts — same cases, same results."""
    raw = str(text or "")
    t = raw
    for _ in range(8):
        m = _ENVELOPE.match(t)
        if not m or m.group(1).lower() in _STRUCTURAL_TAGS or is_host_preamble(t):
            break
        t = t[m.end():]
        close = t.find(f"</{m.group(1)}>")
        if close >= 0:
            t = t[:close] + " " + t[close + len(m.group(1)) + 3:]
    t = _CHANNEL_TAG.sub(" ", t)
    return raw if t == raw else t.strip()


# A channel delivery OPENS the turn, and its tag ends at the first `>` — exactly as
# strip_envelope reads it. See parseChannelEnvelope in src/types.ts for the measurements.
_CHANNEL_OPEN = re.compile(r"^\s*<channel(?=[\s>])([^>]*)(?:>|$)")
# ASCII, like JavaScript's \w: an attribute name is never Thai, and parity is cheaper
# kept than argued about.
_ATTR = re.compile(r'([\w-]+)="([^"]*)"', re.ASCII)


def parse_channel_envelope(text) -> Optional[dict]:
    """Mirror of parseChannelEnvelope in src/types.ts: who sent a turn, from which room,
    on whose clock — or None when the text does not OPEN with a channel envelope that
    names its `source`. Both suites read test/fixtures/channel-envelopes.json."""
    raw = str(text or "")
    m = _CHANNEL_OPEN.match(raw)
    if not m:
        return None
    a: dict[str, str] = {}
    for k, v in _ATTR.findall(m.group(1)):
        a.setdefault(k, v)             # the first of a repeated attribute wins, as in TS
    if not a.get("source"):
        return None
    return {"via": a["source"], "chat_id": a.get("chat_id", ""), "msg_id": a.get("message_id", ""),
            "from_user": a.get("user", ""), "from_user_id": a.get("user_id", ""),
            "sent_ts": a.get("ts", ""), "body": strip_envelope(raw)}


def via_label(via: str) -> str:
    """`plugin:discord:discord` -> `discord`. Display only; the column keeps the raw value."""
    m = re.match(r"^plugin:[^:]*:(.+)\Z", via)     # \Z: JavaScript's $ without the m flag
    return m.group(1) if m else via
