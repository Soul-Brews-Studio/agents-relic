"""Reading from the index — every lookup, as functions that return MODELS.

Nothing here prints or exits. The CLI renders these for a human; anything else
(an MCP server, a notebook) serialises the same objects. When the same lookup exists
twice it drifts, and the copy a model gets is the one no human ever runs by hand.
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import time
from typing import Iterable, Optional, Sequence, TypeVar

from .models import BankGroup, Hit, Scope, Shard, ShardStat
from .repo import default_root, list_shards
from .store import LanceStore

T = TypeVar("T")

# ------------------------------------------------------------------ pure helpers

UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.IGNORECASE
)


def session_id_of_path(path: str, source: str = "") -> str:
    """The session id inside a transcript PATH, without opening the file.

    Every shape but one buries a uuid somewhere in the path, at a different depth:

        <root>/<project>/<uuid>.jsonl                                  claude session
        <root>/<project>/<uuid>/subagents/<agent>.jsonl                claude subagent
        <root>/<project>/<uuid>/subagents/workflows/wf_R/agent-N.jsonl workflow_agent
        <root>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl                    codex

    So the rule is "first uuid anywhere in the path", not "parse the basename" — the
    basename is the uuid for exactly one of those four, and a subagent file would
    otherwise report its AGENT NAME where a session id belongs, which reads like a
    valid answer and is not one.
    """
    m = UUID_RE.search(path)
    if m:
        return m.group(0).lower()
    if source.startswith("omp"):
        base = os.path.basename(path)
        if "_" in base:
            return base.split("_", 1)[1].removesuffix(".jsonl")
    return ""


def max_iso(values: Iterable[Optional[str]]) -> str:
    """Newest non-empty ISO string, or "". An absent timestamp must not win."""
    best = ""
    for v in values:
        s = v or ""
        if s > best:
            best = s
    return best


def dedupe_hits(hits: Sequence[dict]) -> list[dict]:
    """Collapse the SAME EVENT appearing in several banks.

    THE KEY IS CONTENT, NOT `uid`. `uid` hashes a line SLOT, so a resumed session
    writes a new file under the same uuid whose slot 7 holds a different event —
    measured, 8 of 13 real cross-root pairs diverge at line 1, and one pair had 1,018
    slots carrying a different indexed event in each copy. Keying on uid silently
    dropped real results; it shipped once and was reverted.

    `uid` is still the fallback for shapes with no timestamp, where content alone
    cannot separate two genuinely distinct rows.
    """
    seen: set[str] = set()
    out: list[dict] = []
    for h in hits:
        ts = h.get("ts") or ""
        if ts:
            k = "e\x1f" + ts + "\x1f" + str(h.get("role", "")) + "\x1f" + str(h.get("text", ""))
        else:
            k = "u\x1f" + str(h.get("uid", ""))
        if k in seen:
            continue
        seen.add(k)
        out.append(h)
    return out


def group_by_bank(rows: Sequence[ShardStat]) -> list[BankGroup]:
    """Bank first, then repo, biggest first in both.

    A FLAT list sorted by size interleaves what are really several snapshots of one
    machine, and the reader cannot tell whether a repo appears three times because it
    is busy or because it exists in three banks.
    """
    by: dict[str, list[ShardStat]] = {}
    for r in rows:
        by.setdefault(r.bank, []).append(r)
    groups = [
        BankGroup(
            bank=bank,
            rows=sorted(rs, key=lambda r: r.events, reverse=True),
            events=sum(r.events for r in rs),
            sessions=sum(r.sessions for r in rs),
            shards=len(rs),
            last_indexed=max_iso(r.last_indexed for r in rs),
            newest_session=max_iso(r.newest_session for r in rs),
        )
        for bank, rs in by.items()
    ]
    return sorted(groups, key=lambda g: g.events, reverse=True)


# -------------------------------------------------------------------- shard scope


def pick_shards(s: Scope) -> list[Shard]:
    """Which shards this scope may touch.

    `bank` is EXACT and `repo` is a substring of the REPO PORTION only — never of the
    whole shard key, which begins with the bank. Matching `repo` against the key would
    make `repo="projects"` quietly select an entire bank.
    """
    all_shards = list_shards(s.data_root, s.in_repo)
    if s.bank:
        all_shards = [x for x in all_shards if x.bank == s.bank]
    if s.repo:
        all_shards = [x for x in all_shards if s.repo in x.repo]
    return all_shards


def index_status(s: Scope, freshness: bool = True) -> tuple[str, list[ShardStat]]:
    """Per-shard counts, biggest first.

    This doubles as DISCOVERY, and it discovers TWO filters, not one: `bank` takes a
    row's bank exactly, `repo` takes a substring of its repo. It used to be one —
    before banks the shard key WAS the repo key — and a renderer that assumed so
    printed "<bank>/github.com/<org>/<repo>" under the heading "what `repo` accepts",
    which matches nothing.
    """
    rows: list[ShardStat] = []

    def one(sh: Shard) -> Optional[ShardStat]:
        try:
            st = LanceStore.open(sh.dir)
            c = st.counts()
            fr = st.freshness() if freshness else {"last_indexed": "", "newest_session": ""}
            return ShardStat(key=sh.key, bank=sh.bank, repo=sh.repo,
                             events=c["events"], sessions=c["sessions"],
                             last_indexed=fr["last_indexed"],
                             newest_session=fr["newest_session"])
        except Exception:
            return None  # an unreadable shard contributes nothing, it is not fatal

    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for r in pool.map(one, pick_shards(s)):
            if r is not None:
                rows.append(r)
    rows.sort(key=lambda r: r.events, reverse=True)
    return (s.data_root or default_root()), rows


def search_events(query: str, s: Scope, limit: int = 20,
                  all_tiers: bool = False) -> dict:
    """Fan out over the scoped shards, rank ACROSS them, then slice.

    Each shard returns its own top-`limit`, so slicing before the global sort would
    return "the first N shards' best hits", not "the best N hits" — the order would
    depend on directory listing order, which is not a ranking.
    """
    shards = pick_shards(s)
    t0 = time.time()
    where = None if all_tiers else "tier = 'session'"

    def one(sh: Shard) -> list[dict]:
        try:
            rows = LanceStore.open(sh.dir).search(query, limit=limit, where=where)
        except Exception:
            return []
        for r in rows:
            r["repo"] = sh.repo
            r["bank"] = sh.bank
        return rows

    hits: list[dict] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for rows in pool.map(one, shards):
            hits.extend(rows)

    hits.sort(key=lambda r: r.get("_score") or 0.0, reverse=True)
    hits = dedupe_hits(hits)
    total = len(hits)
    return {"hits": [_to_hit(h) for h in hits[:limit]],
            "shards": len(shards), "total": total,
            "ms": int((time.time() - t0) * 1000)}


def _to_hit(h: dict) -> Hit:
    return Hit(
        uid=h.get("uid", ""), session_uuid=h.get("session_uuid", ""),
        file_path=h.get("file_path", ""), repo=h.get("repo", ""),
        seq=int(h.get("seq") or 0), role=h.get("role", ""), ts=h.get("ts", ""),
        text=h.get("text", ""), source=h.get("source", ""), tier=h.get("tier", ""),
        worktree=h.get("worktree", ""), score=float(h.get("_score") or 0.0),
    )
