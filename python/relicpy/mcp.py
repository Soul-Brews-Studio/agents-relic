"""relic over MCP — the same lookups the CLI exposes, as tools a model can call.

The point is that A MODEL SHOULD NOT IMPROVISE A QUERY. Without these tools, finding a
session means guessing at a `find` or a `grep -r` over 25k transcripts: slow, often
wrong, and different every time. Each tool here is one deterministic lookup with named
parameters, so the same question gives the same answer whoever asks it.

Every handler calls query.py — the SAME functions the CLI renders. Nothing is
reimplemented for MCP, because a second copy of a query drifts, and the copy a model
gets is the one no human ever runs by hand.

JSON-RPC is spoken directly rather than through an SDK: the protocol surface used here
is three methods, and the crate's other implementations carry zero or three
dependencies. A framework for `initialize / tools/list / tools/call` would be the
largest dependency in the project.

Run:  relic-py mcp            (stdio)
"""

from __future__ import annotations

import json
import sys
from typing import Any, Optional

from .models import Scope
from .types import parse_channel_envelope

VERSION = "26.9.18"

BANK_DESC = ("One bank — a whole source root, matched EXACTLY (not a substring). Call "
             "relic_status for the banks on this machine; it prints them as headings. "
             "Several banks are usually overlapping snapshots of one machine, so the "
             "SAME session can appear in two: relic_search collapses duplicated events, "
             "relic_sessions does NOT. Scoping to one bank is the cheapest filter there is.")
REPO_DESC = ("Substring of the REPO portion only, e.g. 'neo-oracle'. NOT the shard key: "
             "relic_status groups rows under a bank heading, and only the indented repo "
             "column is what this accepts. STRONGLY RECOMMENDED — without it the query "
             "fans out over every indexed repo.")
SINCE_DESC = "Relative span (7d, 12h, 30m), a date (2026-09-01), or a full ISO timestamp."


def _str(d: str) -> dict:
    return {"type": "string", "description": d}


def _num(d: str) -> dict:
    return {"type": "number", "description": d}


TOOLS = [
    {
        "name": "relic_search",
        "description": "Full-text search across indexed agent session transcripts, "
                       "BM25-ranked. Finds what was SAID — a decision, an error, a "
                       "command. Returns file+seq pointers for relic_show.",
        "inputSchema": {"type": "object", "properties": {
            "query": _str("What to search for."),
            "repo": _str(REPO_DESC), "bank": _str(BANK_DESC), "since": _str(SINCE_DESC),
            "limit": _num("Max hits (default 20)."),
            "all_tiers": {"type": "boolean", "description":
                          "Include subagent and workflow_agent transcripts (73% of the corpus)."},
            "via": _str("Channel turns only: substring of the plugin a turn came in by — the "
                        "envelope's `source`, verbatim, so 'discord' matches plugin:discord:discord "
                        "and arra-oracle-discord. Case-blind."),
            "chat": _str("Channel turns only: substring of the room or thread id (chat_id)."),
            "from_user": _str("Channel turns only: substring of who sent the turn, e.g. 'nazt_'."),
        }, "required": ["query"]},
    },
    {
        "name": "relic_status",
        "description": "What is indexed, grouped BANK first then repo. Call this FIRST "
                       "when you do not know what to filter on — it is the only place "
                       "both filter vocabularies are discoverable. A bank HEADING is "
                       "what `bank` accepts (exact); an indented repo row is what "
                       "`repo` accepts (substring).",
        "inputSchema": {"type": "object", "properties": {
            "bank": _str(BANK_DESC), "limit": _num("Max repo rows PER BANK (default 15).")}},
    },
    {
        "name": "relic_pending",
        "description": "What is on disk but NOT indexed. relic_status reports what was "
                       "imported and can never report what was missed, so this is the "
                       "tool that answers 'is the index actually complete'.",
        "inputSchema": {"type": "object", "properties": {
            "list": _num("Name this many pending sessions (default 0 = counts only)."),
            "bank": _str(BANK_DESC), "repo": _str(REPO_DESC),
            "since": _str("Omit when the question is 'is anything missing' — a since "
                          "scan cannot see a file older than the span.")}},
    },
    {
        "name": "relic_sessions",
        "description": "List or count indexed sessions, newest first, each with its "
                       "NAME. A session matches any window it was active in, on its "
                       "own event timestamps — not file mtime.",
        "inputSchema": {"type": "object", "properties": {
            "repo": _str(REPO_DESC), "bank": _str(BANK_DESC),
            "since": _str(SINCE_DESC), "until": _str(SINCE_DESC),
            "worktree": _str("Worktree name."), "limit": _num("Max rows (default 40).")}},
    },
    {
        "name": "relic_session",
        "description": "One session by id OR BY NAME: totals, tier breakdown, its "
                       "transcripts, and the sessions either side. A session uuid names "
                       "a TREE — parent plus subagent and workflow-agent children.",
        "inputSchema": {"type": "object", "properties": {
            "id": _str("Session uuid, a prefix, or the session's NAME."),
            "repo": _str(REPO_DESC), "bank": _str(BANK_DESC),
            "limit": _num("Max transcripts listed (default 10)."),
            "tree": {"type": "boolean", "description": "Render the tree, not a flat list."},
        }, "required": ["id"]},
    },
    {
        "name": "relic_chain",
        "description": "A session's tree on a TIME axis: what ran sequentially, what ran "
                       "in parallel. Reports peak concurrency and agent-time vs wall "
                       "time — the ratio exceeds 1 only when work genuinely overlapped.",
        "inputSchema": {"type": "object", "properties": {
            "id": _str("Session uuid or prefix."),
            "width": _num("Axis width (default 40)."), "limit": _num("Rows per group (default 8).")},
            "required": ["id"]},
    },
    {
        "name": "relic_show",
        "description": "Read the conversation around one event, straight from the source "
                       ".jsonl. The index stores a pointer, not an archive, so this is "
                       "always current. Take `file` and `seq` from a relic_search hit.",
        "inputSchema": {"type": "object", "properties": {
            "file": _str("Absolute path, as returned by relic_search."),
            "seq": _num("Event number within that file."),
            "before": _num("Context lines before (default 2)."),
            "after": _num("Context lines after (default 2)."),
        }, "required": ["file", "seq"]},
    },
    {
        "name": "relic_now",
        "description": "What is running RIGHT NOW. Answered from file mtime, NOT the "
                       "index: a transcript being appended to cannot be in an index that "
                       "already ran, so this is the only tool here current to the second.",
        "inputSchema": {"type": "object", "properties": {
            "all": {"type": "boolean", "description": "Every recently-active session."},
            "window": _num("Seconds a write must be within to count as live (default 300)."),
            "limit": _num("Max rows (default 15).")}},
    },
]


def _facet_arg(name: str, v) -> Optional[str]:
    """Mirror of facetArg in src/query.ts: a number is converted, a bare flag or an empty
    value refused — inside the fan-out either one used to read as \"no matches\"."""
    if v is None:
        return None
    if isinstance(v, bool):
        raise ValueError(f"{name} needs a value, e.g. {name} discord")
    # Python's json keeps an int exact, so unlike the TypeScript side a whole chat id sent
    # as a number is fine. A float is not exact, and a dict or list would be searched for
    # as its repr.
    if not isinstance(v, (str, int)):
        raise ValueError(f"{name} must be a string")
    out = str(v).strip()
    if not out:
        raise ValueError(f"{name} needs a non-empty value")
    return out


def _channel_head(c: dict) -> str:
    """Mirror of channelHead(c, {full: true}) in src/query.ts: every id whole, because a
    model replying through the channel plugin addresses the exact chat_id and message_id."""
    who = c["from_user"] + (f" (user_id {c['from_user_id']})" if c["from_user_id"] else "") if c["from_user"] else ""
    parts = [who, f"via {c['via']}", c["chat_id"] and f"chat_id {c['chat_id']}",
             c["msg_id"] and f"message_id {c['msg_id']}", c["sent_ts"] and f"sent {c['sent_ts']}"]
    return " · ".join(p for p in parts if p)


def _scope(a: dict) -> Scope:
    import os
    return Scope(data_root=os.environ.get("RELIC_DATA_ROOT") or None,
                 in_repo=os.environ.get("RELIC_IN_REPO") == "1",
                 repo=a.get("repo") or None, bank=a.get("bank") or None)


def run(name: str, a: dict) -> str:
    from .query import (dedupe_hits, floor_note, group_by_bank, index_status, list_sessions,
                        match_count, max_iso, memory_report, name_of, pending_report,
                        pick_shards, read_around, resolve_session, search_events, stats_of)
    from .time import local_date_time, local_time
    scope = _scope(a)

    if name == "relic_status":
        root, rows = index_status(scope)
        if not rows:
            return f"no shards indexed under {root}\nrun: relic index --since 7d"
        limit = int(a.get("limit") or 15)
        banks = group_by_bank(rows)
        when = lambda x: local_date_time(x) if x else "never"
        L = [f"index {root} · LanceDB + ICU full-text (BM25)",
             f"{len(banks)} bank(s) · {len(rows)} shards",
             f"last indexed {when(max_iso(r.last_indexed for r in rows))} · "
             f"newest session {when(max_iso(r.newest_session for r in rows))}", "",
             "bank = the heading (exact) · repo = the indented column (substring)", ""]
        for b in banks:
            L.append(f"{b.bank}   {b.sessions:,} sessions · {b.events:,} events · {b.shards} shards")
            for r in b.rows[:limit]:
                L.append(f"  {r.repo.replace('github.com/', ''):46} "
                         f"{r.sessions:>6} sess {r.events:>11,} ev")
            if len(b.rows) > limit:
                L.append(f"  ... and {len(b.rows) - limit} more (raise limit)")
            L.append("")
        L.append(f"total {sum(r.events for r in rows):,} events · "
                 f"{sum(r.sessions for r in rows):,} sessions · {len(rows)} shards")
        return "\n".join(L)

    if name == "relic_search":
        q = str(a.get("query") or "").strip()
        if not q:
            return "relic_search needs a non-empty query"
        if not pick_shards(scope):
            return "no shards match — call relic_status to see what is indexed"
        try:
            facets = {k: _facet_arg(k, a.get(k)) for k in ("via", "chat", "from_user")}
        except ValueError as e:
            return f"relic_search: {e}"
        limit = int(a.get("limit") or 20)
        res = search_events(q, scope, limit=limit,
                            all_tiers=bool(a.get("all_tiers")), **facets)
        note = (f'{res["unfaceted_turns"]} channel turns in {res["unfaceted"]} of {res["shards"]} shards '
                f'predate channel facets and cannot match via/chat/from_user until '
                f'`relic index --backfill-channel --apply` fills them') if res.get("unfaceted") else ""
        if not res["hits"]:
            return f'no matches for "{q}" across {res["shards"]} shards ({res["ms"]} ms)' + (f"\n{note}" if note else "")
        narrowed = "" if a.get("all_tiers") else \
            "  ·  main sessions only — pass all_tiers:true for subagent/workflow work"
        floor = floor_note(res["capped"], res["shards"], limit)
        L = [f'{match_count(len(res["hits"]), res["total"], res["capped"])} matches · '
             f'{res["shards"]} shards · {res["ms"]} ms{narrowed}',
             *([f"{floor}. Pass repo or a higher limit for an exact count."] if floor else []),
             *([note] if note else []), ""]
        for h in res["hits"]:
            L.append(f"{h.repo}{' [' + h.worktree + ']' if h.worktree else ''} · "
                     f"{h.source}/{h.tier} · {h.role} · {h.ts}")
            c = parse_channel_envelope(h.text) if h.role == "user" else None
            if c:
                L.append(f"  {_channel_head(c)}")
            L.append(f"  ...{' '.join((c['body'] if c else h.text).split())[:260]}...")
            L.append(f"  relic_show  file={h.file_path}  seq={int(h.seq)}")
            L.append("")
        return "\n".join(L)

    if name == "relic_pending":
        r = pending_report(scope, since=a.get("since"), list_n=int(a.get("list") or 0))
        L = [f"found {r.found:,} · indexed {r.indexed:,} · missing {r.missing:,} · "
             f"changed {r.changed:,} · {r.scan_ms} ms"]
        # An MCP client never sees stderr, so the walk's failures have to be in the
        # answer — without them "nothing pending" is exactly the #99 report.
        if r.unreadable:
            n = len(r.unreadable)
            L += ["", f"⚠ {n:,} path{'' if n == 1 else 's'} could not be read — files under "
                      f"{'it are' if n == 1 else 'them are'} in none of these counts:"]
            L += [f"    {x['path']}  ({x['error']})" for x in r.unreadable[:10]]
            if n > 10:
                L.append(f"    ... and {n - 10:,} more")
        if not r.missing and not r.changed:
            L += ["", "nothing pending among the files the walk could read." if r.unreadable
                  else "nothing pending — every discovered file is in the index."]
        L.append("")
        for g in r.groups:
            L.append(f"  {g.source + '/' + g.tier:30} found {g.found:>6}  "
                     f"missing {g.missing:>6}  changed {g.changed:>6}")
        for x in r.files:
            L += ["", f"{local_date_time(x.mtime)}  {x.session_id or '(no session id)'}  {x.state}",
                  f"    {x.repo}  ·  bank {x.bank}  ·  {x.source}/{x.tier}", f"    {x.path}"]
        return "\n".join(L)

    if name == "relic_sessions":
        if not pick_shards(scope):
            return "no shards match — call relic_status"
        r = list_sessions(scope, since=a.get("since"), until=a.get("until"),
                          worktree=a.get("worktree"), limit=int(a.get("limit") or 40))
        if not r["total"]:
            return "no sessions match those filters"
        L = [f"{r['total']:,} sessions · {r['transcripts']:,} transcripts · "
             f"{r['events']:,} events", ""]
        for x in r["rows"]:
            kids = f" +{x['children']}" if x.get("children") else ""
            L.append(f"{local_date_time(x.get('started_at'))}  {str(x.get('session_uuid'))[:8]}{kids}  "
                     f"{int(x.get('tree_events') or 0):>6} ev  {x.get('repo','')}")
            L.append(f"    {' '.join(name_of(x).split())[:110]}")
        return "\n".join(L)

    if name == "relic_session":
        res = resolve_session(str(a.get("id")), scope)
        rows = res["rows"]
        if not rows:
            return f"nothing matches {a.get('id')}"
        st = stats_of(rows)
        parent = next((r for r in rows if r.get("tier") == "session"), rows[0])
        L = [name_of(parent),
             f"{parent.get('session_uuid')} · matched by {res['matched_by']}"
             + (f" · {res['imported']} imported on demand" if res["imported"] else ""),
             f"{st['repo']} · {local_date_time(st['started_at'])} → "
             f"{local_date_time(st['ended_at'])} · {st['transcripts']:,} transcripts · "
             f"{st['events']:,} events" + (f" · {st['runs']} workflow runs" if st["runs"] else ""),
             "  " + " · ".join(f"{t} {n}" for t, n in st["tiers"]), ""]
        base = str(parent.get("file_path", "")).replace(".jsonl", "/")
        L.append(f"transcripts (under {base}):")
        for r in rows[:int(a.get("limit") or 10)]:
            p = r["file_path"][len(base):] if r["file_path"].startswith(base) else r["file_path"]
            L.append(f"  {local_time(r.get('started_at'))}  {str(r.get('tier')):14} "
                     f"{int(r.get('event_count') or 0):>6} ev  {p}")
        return "\n".join(L)

    if name == "relic_chain":
        from .chain import build_chain, render_chain
        res = resolve_session(str(a.get("id")), scope)
        if not res["rows"]:
            return f"no session matches {a.get('id')}"
        head = f"({res['imported']} transcripts imported on demand)\n\n" if res["imported"] else ""
        return head + render_chain(build_chain(str(a.get("id")), res["rows"]),
                                   int(a.get("width") or 40), int(a.get("limit") or 8))

    if name == "relic_show":
        lines = read_around(str(a.get("file")), int(a.get("seq")),
                            int(a.get("before") or 2), int(a.get("after") or 2))
        if not lines:
            return f"no events around seq {a.get('seq')} in {a.get('file')}"
        return "\n".join(f"{'>>' if l['target'] else '  '} #{l['seq']} {l['role']}: "
                         f"{' '.join(l['text'].split())[:1200]}" for l in lines)

    if name == "relic_now":
        from .live import current_session, human_age, live_sessions, tree_files
        window = int(a.get("window") or 300)
        if a.get("all"):
            live = live_sessions(window, int(a.get("limit") or 20))
            if not live:
                return f"nothing written in the last {human_age(window)}"
            L = [f"{len(live)} session(s) active in the last {human_age(window)}", ""]
            for x in live:
                L.append(f"{human_age(x['age_sec']):>5} ago  {x['session_uuid']}  "
                         f"{x['agents']} live agent(s)  {x['title'] or '(untitled)'}")
                L.append(f"            {x['cwd'] or x['project_dir']}")
            return "\n".join(L)
        cur = current_session()
        if not cur:
            return "no session transcript for the current directory\ncall again with all=true"
        files = tree_files(cur["project_dir"], cur["session_uuid"])
        agents = [f for f in files if f["tier"] != "session" and f["age_sec"] <= window]
        return "\n".join([cur["title"] or "(untitled)",
                          f"{cur['session_uuid']} · last write {human_age(cur['age_sec'])} ago",
                          cur["cwd"] or "", f"{len(files)} transcripts in the tree",
                          f"{len(agents)} live agent(s) in the last {human_age(window)}"])

    return f"unknown tool {name}"


def _send(obj: Any) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def serve() -> int:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        method, rid = req.get("method"), req.get("id")
        if method == "initialize":
            _send({"jsonrpc": "2.0", "id": rid, "result": {
                "protocolVersion": "2024-11-05", "capabilities": {"tools": {}},
                "serverInfo": {"name": "relic-py", "version": VERSION}}})
        elif method == "tools/list":
            _send({"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}})
        elif method == "tools/call":
            p = req.get("params") or {}
            try:
                text = run(p.get("name", ""), p.get("arguments") or {})
                _send({"jsonrpc": "2.0", "id": rid,
                       "result": {"content": [{"type": "text", "text": text}]}})
            except Exception as err:
                # A thrown handler kills the call with no explanation on the model's
                # side. Return the message as content so the failure is legible.
                _send({"jsonrpc": "2.0", "id": rid, "result": {
                    "content": [{"type": "text", "text": f"relic error: {err}"}],
                    "isError": True}})
        elif rid is not None:
            _send({"jsonrpc": "2.0", "id": rid,
                   "error": {"code": -32601, "message": f"unknown method {method}"}})
    return 0
