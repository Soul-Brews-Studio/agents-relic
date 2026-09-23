"""Reading from the index — every lookup, as functions that return MODELS.

Nothing here prints or exits. The CLI renders these for a human; anything else
(an MCP server, a notebook) serialises the same objects. When the same lookup exists
twice it drifts, and the copy a model gets is the one no human ever runs by hand.
"""

from __future__ import annotations

import concurrent.futures
import json
import os
import re
import time
from typing import Iterable, Optional, Sequence, TypeVar

from .models import (BankGroup, Hit, PendingFile, PendingGroup, PendingReport,
                     Scope, Shard, ShardStat)
from .repo import default_root, list_shards, repo_key_of, resolve_repo_key
from .store import LanceStore
from .types import block_role, flatten_content
from .types import is_host_preamble, parse_channel_envelope, strip_envelope

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
                  all_tiers: bool = False, via: Optional[str] = None,
                  chat: Optional[str] = None, from_user: Optional[str] = None) -> dict:
    """Fan out over the scoped shards, rank ACROSS them, then slice.

    Each shard returns its own top-`limit`, so slicing before the global sort would
    return "the first N shards' best hits", not "the best N hits" — the order would
    depend on directory listing order, which is not a ranking.
    """
    shards = pick_shards(s)
    t0 = time.time()

    faceting = bool(via or chat or from_user)

    def one(sh: Shard) -> tuple[list[dict], int]:
        stale = 0
        try:
            st = LanceStore.open(sh.dir)
            # Channel facets, as in src/query.ts: turns indexed before the columns cannot
            # match, so count them — from the rows, never the schema — and say so.
            if faceting:
                stale = sum(1 for t in st.unfaceted_channel_texts() if parse_channel_envelope(t))
            facet = st.facet_filter(via, chat, from_user)
            if facet is None:
                return [], stale
            # PER SHARD, not once: the filter depends on whether THIS shard has the
            # `kind` column, and 509 of the 817 on disk do not. A single filter computed
            # up front is invalid SQL on one of the two populations, and the per-shard
            # catch below turns that into "no matches" rather than an error.
            #
            # It also used to read `tier = 'session'` flat, which silently excluded every
            # vault note and every hermes message from the default search here while the
            # TypeScript implementation included them — the two answered the same query
            # differently, and neither reported a problem.
            where = None if all_tiers else st.main_tiers_filter()
            if facet:
                where = facet if where is None else f"({where}) AND {facet}"
            rows = st.search(query, limit=limit, where=where)
        except Exception:
            return [], stale
        for r in rows:
            r["repo"] = sh.repo
            r["bank"] = sh.bank
        return rows, stale

    hits: list[dict] = []
    unfaceted = unfaceted_turns = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
        for rows, stale in pool.map(one, shards):
            hits.extend(rows)
            if stale:
                unfaceted += 1
                unfaceted_turns += stale

    hits.sort(key=lambda r: r.get("_score") or 0.0, reverse=True)
    hits = dedupe_hits(hits)
    total = len(hits)
    out = {"hits": [_to_hit(h) for h in hits[:limit]],
           "shards": len(shards), "total": total,
           "ms": int((time.time() - t0) * 1000)}
    if faceting:
        out.update(unfaceted=unfaceted, unfaceted_turns=unfaceted_turns)
    return out


def _to_hit(h: dict) -> Hit:
    return Hit(
        uid=h.get("uid", ""), session_uuid=h.get("session_uuid", ""),
        file_path=h.get("file_path", ""), repo=h.get("repo", ""),
        seq=int(h.get("seq") or 0), role=h.get("role", ""), ts=h.get("ts", ""),
        text=h.get("text", ""), source=h.get("source", ""), tier=h.get("tier", ""),
        worktree=h.get("worktree", ""), score=float(h.get("_score") or 0.0),
    )


# --------------------------------------------------------------- sessions & trees

def name_of(row: dict) -> str:
    """What to CALL a session: the host's title, else the opening user message.

    A uuid is not a name. Falling back to the description is what makes `relic
    sessions` readable without opening anything — but the raw description is rarely a
    name, and this used to return it verbatim. Sessions opened by a slash command were
    listed as a wall of XML, and sessions resumed after a compaction were listed as
    "<local-command-caveat>Caveat: The messages below were genera". Both are
    boilerplate the host wrote, not something the human called the session.

    Mirrors the TypeScript nameOf() step for step, including the order of the
    replacements — a session's displayed name should not depend on which reader you
    asked.
    """
    t = str(row.get("title") or "").strip()
    if t:
        return t

    d = str(row.get("description") or "")
    # A slash command: the command NAME is the useful part, so promote it.
    cmd = re.search(r"<command-name>\s*(/?[\w:-]+)\s*</command-name>", d)
    if cmd:
        args = re.search(r"<command-args>([\s\S]*?)</command-args>", d)
        arg = args.group(1).strip() if args else ""
        name = f"{cmd.group(1)} {arg}" if arg else cmd.group(1)
        return re.sub(r"\s+", " ", name)[:70]

    # description is truncated at 200 chars, so a caveat block often has no closing tag
    # to match against. Drop from the opening tag to the end rather than leaving the
    # boilerplate as the session's name.
    # A host's own boot directive is not a name. Claude's two shapes were already
    # handled below; Codex's three were not, and they are 64% of its sessions.
    if is_host_preamble(d):
        return "(untitled)"

    # Rows indexed before import stripped envelopes still carry them, cut at 200 chars.
    d = strip_envelope(re.sub(r"\.\.\.\[\+\d+\]$", "", d))
    if is_host_preamble(d):
        return "(untitled)"

    d = re.sub(r"<local-command-caveat>[\s\S]*$", "", d)
    d = re.sub(r"^\s*Caveat: The messages below were generated[\s\S]*$", "", d)
    # A pasted image carries a long tag the {1,40} scrubber cannot reach, and a message
    # is often JUST the tag. Whatever the human typed after it is the name.
    d = re.sub(r"<image\b[^>]*>", " ", d, flags=re.I)
    d = re.sub(r"<[^>]{1,40}>", " ", d)
    d = re.sub(r"\s+", " ", d).strip()
    return d[:70] if d else "(untitled)"


def looks_like_id(s: str) -> bool:
    """Could this string BE a session id? A name has no file to find, so seeking on
    one would walk every source directory to return nothing."""
    return bool(re.fullmatch(r"[0-9a-fA-F][0-9a-fA-F-]{3,}", s or ""))


#: The three tiers that are a CONVERSATION. `note` and `memory` are other kinds of
#: thing that happen to share the `sessions` table, and they outnumber conversations
#: 100:1 — see the tier note in list_sessions.
TRANSCRIPT_TIERS = ["session", "subagent", "workflow_agent"]


def group_transcripts(rows: list[dict]) -> list[dict]:
    """Fold a flat transcript list into one row per conversation TREE.

    Ported from `groupTranscripts` in src/query.ts — see issue #46. Without this,
    `sessions` counts FILES: one fan-out that spawned 11 workflow agents reads as 12
    sessions, all sharing a uuid, and the listing fills with agent prompts instead of
    the human's.

    The parent row represents the group — the `session` tier row, falling back to the
    earliest transcript in the tree so a session is never silently dropped when it was
    indexed without its own parent file.

    KEYED ON `(repo, session_uuid)`, NOT `session_uuid` ALONE. `session_uuid` is not a
    key across shards: the three Claude roots overlap by 742 sessions on this machine's
    index, so grouping on the uuid alone would fold two DIFFERENT people's sessions
    (same uuid, different repo/bank) into one tree. `src/report.ts` already learned
    this — its `groupSessions` keys on the pair — while `groupTranscripts` in
    `src/query.ts` gets away with the uuid alone only because `listSessions` there
    scopes to one shard set before grouping. This port does not make that assumption.
    """
    by: dict[tuple[str, str], list[dict]] = {}
    for r in rows:
        k = (str(r.get("repo") or ""), str(r.get("session_uuid") or r.get("file_path") or ""))
        by.setdefault(k, []).append(r)
    out: list[dict] = []
    for group in by.values():
        group.sort(key=lambda r: str(r.get("started_at") or ""))
        parent = next((r for r in group if r.get("tier") == "session"), group[0])
        out.append({
            **parent,
            "children": len(group) - 1,
            "tree_events": sum(int(r.get("event_count") or 0) for r in group),
        })
    return out


def list_sessions(scope: Scope, since: Optional[str] = None, until: Optional[str] = None,
                  worktree: Optional[str] = None, limit: int = 40,
                  tiers: Optional[list[str]] = None, group: bool = True) -> dict:
    """Newest first, filtered on the session's OWN event timestamps — not file mtime.

    A session matches any window it was active in (started before it closed, last
    event after it opened); its row still shows its own start.

    TIER, BECAUSE `sessions` HOLDS ONE ROW PER INDEXED FILE — of any kind. A vault
    note is a row here, and the vault dwarfs everything else. Measured 2026-09-22
    with --since 7d over the live index:

        42,403  note        <- psi/*.md, one row each
           382  session     <- what anybody asking "how many sessions" means
            34  memory
             8  subagent

    So the unfiltered answer was off by 112x, and the daily histogram showed three
    enormous spikes that were vault INDEXING runs, not activity.

    GROUPING, BY DEFAULT — see #46. A conversation is a TREE: one `session` transcript
    plus whatever `subagent` and `workflow_agent` transcripts it spawned, all sharing a
    uuid. Ungrouped, `sessions` counts files, so a fan-out that spawned 11 workflow
    agents read as 12 sessions instead of 1 — measured on this index, 1,248 transcripts
    collapse to 390 real conversations over 7 days. `group=False` (the CLI's
    `--all-tiers`) returns one row per transcript instead, with `children` and
    `tree_events` filled in trivially (0 / its own event_count) so callers can rely on
    both fields either way.
    """
    rows: list[dict] = []
    for sh in pick_shards(scope):
        try:
            for r in LanceStore.open(sh.dir).session_rows():
                r["repo"] = sh.repo
                r["bank"] = sh.bank
                rows.append(r)
        except Exception:
            continue
    keep = set(TRANSCRIPT_TIERS if tiers is None else tiers)
    rows = [r for r in rows if (r.get("tier") or "") in keep]
    if since:
        lo = to_iso(since)
        # Overlap, not start-in-window: a session still running inside the window was active in it.
        rows = [r for r in rows if (r.get("ended_at") or "") >= lo
                or (not r.get("ended_at") and (r.get("started_at") or "") >= lo)]
    if until:
        hi = to_iso(until)
        rows = [r for r in rows if (r.get("started_at") or "") <= hi]
    if worktree:
        rows = [r for r in rows if worktree in (r.get("worktree") or "")]
    events = sum(int(r.get("event_count") or 0) for r in rows)
    if group:
        grouped = group_transcripts(rows)
    else:
        grouped = [{**r, "children": 0, "tree_events": int(r.get("event_count") or 0)}
                  for r in rows]
    grouped.sort(key=lambda r: r.get("started_at") or "", reverse=True)
    return {"rows": grouped[:limit], "total": len(grouped), "transcripts": len(rows),
           "events": events}


def find_session_by_id(session_id: str, scope: Scope) -> list[dict]:
    out: list[dict] = []
    for sh in pick_shards(scope):
        try:
            for r in LanceStore.open(sh.dir).session_rows():
                # BOTH clauses, matching LanceStore.findSession(). A session's tree
                # includes transcripts whose OWN session_uuid differs — they live under
                # the session's directory, so the id is in their path. Matching the uuid
                # alone silently returns a smaller tree, which is how this diverged from
                # the reference by one row without either side erroring.
                if not (str(r.get("session_uuid") or "").startswith(session_id)
                        or session_id in str(r.get("file_path") or "")):
                    continue
                # journal.jsonl is the workflow RUNNER's event log, not a transcript.
                # Discovery has skipped it since 2026-09-18; rows written before that
                # remain, because the index has no prune. Without this every session
                # tree containing a workflow reports one transcript too many.
                if str(r.get("file_path") or "").endswith("/journal.jsonl"):
                    continue
                r["repo"] = sh.repo
                r["bank"] = sh.bank
                out.append(r)
        except Exception:
            continue
    return out


def find_session_by_name(name: str, scope: Scope) -> list[dict]:
    needle = name.lower()
    out: list[dict] = []
    for sh in pick_shards(scope):
        try:
            for r in LanceStore.open(sh.dir).session_rows():
                hay = f"{r.get('title') or ''} {r.get('description') or ''}".lower()
                if needle in hay:
                    r["repo"] = sh.repo
                    r["bank"] = sh.bank
                    out.append(r)
        except Exception:
            continue
    return out


def resolve_session(ident: str, scope: Scope, no_index: bool = False) -> dict:
    """id first, then name, then DISK.

    Seeking on a miss is what makes this answer for a session that was never imported,
    instead of saying "run index first" to a question the tool can resolve itself.
    """
    rows = find_session_by_id(ident, scope)
    if rows:
        return {"rows": rows, "imported": 0, "matched_by": "id"}

    if not no_index and looks_like_id(ident):
        from .importer import import_files
        from .seek import seek_on_disk
        found = seek_on_disk(ident)
        if found:
            t = import_files(found, data_root=scope.data_root, in_repo=scope.in_repo)
            rows = find_session_by_id(ident, scope)
            if rows:
                return {"rows": rows, "imported": t.imported, "matched_by": "id"}

    rows = find_session_by_name(ident, scope)
    return {"rows": rows, "imported": 0, "matched_by": "name" if rows else "none"}


def stats_of(rows: list[dict]) -> Optional[dict]:
    """Roll a session's TREE up into the few numbers worth printing above it."""
    if not rows:
        return None
    tiers: dict[str, int] = {}
    for r in rows:
        t = r.get("tier") or ""
        tiers[t] = tiers.get(t, 0) + 1
    runs = {r.get("workflow_run_id") for r in rows if r.get("workflow_run_id")}
    starts = sorted(x for x in (r.get("started_at") or "" for r in rows) if x)
    ends = sorted(x for x in (r.get("ended_at") or "" for r in rows) if x)
    parent = next((r for r in rows if r.get("tier") == "session"), rows[0])
    return {
        "transcripts": len(rows),
        "events": sum(int(r.get("event_count") or 0) for r in rows),
        "tiers": sorted(tiers.items(), key=lambda kv: -kv[1]),
        "runs": len(runs),
        "started_at": starts[0] if starts else "",
        "ended_at": ends[-1] if ends else "",
        "repo": parent.get("repo") or parent.get("repo_key") or "",
        "worktree": parent.get("worktree") or "",
        "model": parent.get("model") or "",
    }


def neighbours(row: dict, scope: Scope, before: int = 5, after: int = 5) -> dict:
    """The sessions either side of this one in the same worktree.

    Queries every shard with the same REPO, across banks, then folds by session_uuid
    keeping the highest event_count — a cross-bank copy is the same session, not a
    neighbour of itself.
    """
    iso = str(row.get("started_at") or "")
    if not iso:
        return {"before": [], "after": []}
    want_repo = row.get("repo") or ""
    wt = row.get("worktree") or ""
    seen: dict[str, dict] = {}
    for sh in pick_shards(Scope(data_root=scope.data_root, in_repo=scope.in_repo)):
        if sh.repo != want_repo:
            continue
        try:
            for r in LanceStore.open(sh.dir).session_rows():
                if (r.get("worktree") or "") != wt or r.get("tier") != "session":
                    continue
                k = str(r.get("session_uuid"))
                if k not in seen or int(r.get("event_count") or 0) > int(seen[k].get("event_count") or 0):
                    seen[k] = r
        except Exception:
            continue
    rows = sorted(seen.values(), key=lambda r: r.get("started_at") or "")
    idx = next((i for i, r in enumerate(rows)
                if str(r.get("session_uuid")) == str(row.get("session_uuid"))), None)
    if idx is None:
        return {"before": [], "after": []}
    return {"before": rows[max(0, idx - before):idx], "after": rows[idx + 1:idx + 1 + after]}


def read_around(file_path: str, seq: int, before: int = 2, after: int = 2) -> list[dict]:
    """Read the conversation around one event STRAIGHT FROM THE SOURCE .jsonl.

    The index stores a pointer, not an archive, so this is always current — and it
    works for a file that was never imported.
    """
    lo, hi = seq - before, seq + after
    out: list[dict] = []
    n = 0
    try:
        with open(file_path, "r", encoding="utf-8", errors="replace") as fh:
            for line in fh:
                if not line.strip():
                    continue          # seq counts NON-EMPTY lines — must match the parser
                n += 1
                if n < lo:
                    continue
                if n > hi:
                    break
                try:
                    rec = json.loads(line)
                except Exception:
                    continue
                msg = rec.get("message") if isinstance(rec, dict) else None
                raw = (msg or {}).get("content") if isinstance(msg, dict) else rec.get("content", "")
                role = block_role(raw) or (msg or {}).get("role") or rec.get("type") or ""
                out.append({"seq": n, "role": role,
                            "text": flatten_content(raw).strip(), "target": n == seq})
    except OSError:
        return []
    return out


def to_iso(spec: str) -> str:
    """A filter bound as an ISO string. Comparisons on `started_at` are STRING
    comparisons against stored ISO text, so the bound must be the same shape."""
    from datetime import datetime, timedelta, timezone
    m = re.fullmatch(r"(\d+)([mhd])", spec or "")
    if m:
        n = int(m.group(1))
        delta = {"m": timedelta(minutes=n), "h": timedelta(hours=n), "d": timedelta(days=n)}[m.group(2)]
        return (datetime.now(timezone.utc) - delta).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    # Stored stamps are UTC text, so an offset or a bare local time must be converted first.
    if "T" in (spec or ""):
        try:
            dt = datetime.fromisoformat(spec.replace("Z", "+00:00"))
        except ValueError:
            return spec
        if dt.tzinfo is None:
            dt = dt.astimezone()
        return dt.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return spec


# ------------------------------------------------ what is on disk but NOT indexed

def pending_report(scope: Scope, corpus: Optional[list[str]] = None,
                   since: Optional[str] = None, list_n: int = 0) -> PendingReport:
    """Discovered-on-disk minus already-imported: the backlog, before an index run.

    THE ONE CHECK THAT CATCHES A PARTIAL INDEX. `status` reports what was imported and
    can never report what was missed, so a half-indexed corpus prints healthy totals.
    Measured: an index run with --since 7d left 3,591 workflow_agent + 427 subagent +
    361 session files unseen while status showed 3 M events.

    Omit `since` when the question is "is anything missing" — a --since scan
    structurally cannot see a file older than the span.
    """
    from .discover import discover, parse_since
    from .unreadable import walk_failures
    t0 = time.time()

    seen: dict[str, dict] = {}
    for sh in pick_shards(scope):
        try:
            seen.update(LanceStore.open(sh.dir).manifest())
        except Exception:
            continue          # an unreadable shard contributes nothing; it just looks unindexed

    since_ms = parse_since(since) if since else None
    # `bank` must narrow BOTH sides. It already narrows the manifest via pick_shards;
    # without the same filter here every source's files count as missing against a
    # manifest that was never asked for them.
    found = [f for f in discover(corpus, since_ms) if not scope.bank or f.bank == scope.bank]
    unreadable = walk_failures()

    groups: dict[str, PendingGroup] = {}
    indexed = changed = missing = 0
    newest: Optional[int] = None
    pending: list[tuple] = []
    for f in found:
        k = f"{f.source}/{f.tier}"
        g = groups.setdefault(k, PendingGroup(source=f.source, tier=f.tier))
        g.found += 1
        prior = seen.get(f.path)
        if not prior:
            g.missing += 1; missing += 1; pending.append((f, "missing"))
        elif prior["mtime"] != f.mtime or prior["size"] != f.size:
            g.changed += 1; changed += 1; pending.append((f, "changed"))
        else:
            g.indexed += 1; indexed += 1
        if not prior or prior["mtime"] != f.mtime or prior["size"] != f.size:
            newest = max(newest or 0, f.mtime * 1000)

    # THE LIST IS CAPPED AND PARSED; THE COUNTS ARE NEITHER. A file's repo is not
    # knowable from its path (the encoding maps both "/" and "." to "-"), so it is read
    # from the transcript's own cwd — which means opening it.
    #
    # AUTO-LIST WHEN THE SET IS SMALL. Listing was opt-in because it costs one file read
    # per row, but the common case is a handful of files — where the summary's
    # "missing 1" is exactly the wrong amount of information: it reports that something
    # is missing and makes the reader go find out what. Ten transcripts is milliseconds;
    # thirty thousand is why the cap exists. So None means "decide for me", and 0 still
    # means "none", which is not the same thing.
    AUTO_LIST = 10
    pending.sort(key=lambda x: x[0].mtime, reverse=True)
    cap = min(len(pending), AUTO_LIST) if list_n is None else max(0, int(list_n))
    files: list[PendingFile] = []
    for f, state in pending[:cap]:
        repo, cwd, name = "_unresolved", "", ""
        try:
            parsed = f.parser(f.path)
            cwd = parsed.cwd or ""
            repo = resolve_repo_key(parsed.cwd) or "_unresolved"
            name = name_of({"title": getattr(parsed, "title", ""),
                            "description": getattr(parsed, "description", "")})
        except Exception:
            pass          # an unparseable file is exactly why it is still pending
        files.append(PendingFile(path=f.path, bank=f.bank, source=f.source, tier=f.tier,
                                 state=state, mtime=f.mtime, size=f.size,
                                 session_id=session_id_of_path(f.path, f.source),
                                 repo=repo, cwd=cwd, name=name))

    return PendingReport(
        groups=sorted(groups.values(), key=lambda g: -(g.missing + g.changed)),
        found=len(found), indexed=indexed, changed=changed, missing=missing,
        newest_pending_ms=newest, scan_ms=int((time.time() - t0) * 1000),
        files=files, files_omitted=max(0, len(pending) - len(files)),
        unreadable=unreadable,
    )


def memory_report(scope: Scope, mem_type: Optional[str] = None, limit: int = 20) -> dict:
    """Claude's own memory, JOINED to the sessions that produced it.

    THE JOIN CROSSES BANKS, and that is the whole difficulty: memories live in bank
    `memory` and transcripts in `projects*`, so a join inside one shard is structurally
    empty. It returned 0 until the transcript side was collected across ALL shards
    first — a zero that looked like an answer.
    """
    all_ids: set[str] = set()
    tx_by_repo: dict[str, int] = {}
    for sh in pick_shards(Scope(data_root=scope.data_root, in_repo=scope.in_repo,
                                repo=scope.repo)):
        try:
            for r in LanceStore.open(sh.dir).session_rows():
                all_ids.add(str(r.get("session_uuid") or ""))
                tx_by_repo[sh.repo] = tx_by_repo.get(sh.repo, 0) + 1
        except Exception:
            continue

    rows: list[dict] = []
    by_type: dict[str, int] = {}
    producing: dict[str, set] = {}
    mem_by_repo: dict[str, int] = {}
    for sh in pick_shards(Scope(data_root=scope.data_root, in_repo=scope.in_repo,
                                repo=scope.repo, bank="memory")):
        try:
            st = LanceStore.open(sh.dir)
            t = st._existing("events")
            if t is None:
                continue
            for r in t.to_arrow().to_pylist():
                if mem_type and r.get("mem_type") != mem_type:
                    continue
                r["repo"] = sh.repo
                rows.append(r)
                by_type[r.get("mem_type") or "(untyped)"] = by_type.get(r.get("mem_type") or "(untyped)", 0) + 1
                mem_by_repo[sh.repo] = mem_by_repo.get(sh.repo, 0) + 1
                if r.get("origin_session"):
                    producing.setdefault(sh.repo, set()).add(r["origin_session"])
        except Exception:
            continue

    with_origin = [r for r in rows if r.get("origin_session")]
    joined = [r for r in with_origin
              if any(i.startswith(str(r["origin_session"])[:8]) for i in all_ids)]
    rows.sort(key=lambda r: r.get("ts") or "", reverse=True)
    return {
        "total": len(rows), "by_type": by_type,
        "with_origin": len(with_origin), "joined": len(joined),
        "orphaned": len(with_origin) - len(joined),
        "no_origin": len(rows) - len(with_origin),
        "repos": sorted(
            ({"repo": k, "mem": v, "transcripts": tx_by_repo.get(k, 0),
              "producing": len(producing.get(k, set()))} for k, v in mem_by_repo.items()),
            key=lambda x: -x["mem"])[:limit],
        "rows": rows[:limit],
    }
