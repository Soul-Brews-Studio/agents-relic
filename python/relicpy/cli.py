"""relic-py — the reference CLI's read surface, over the same index.

Deliberately a READER. Indexing is where the two implementations could corrupt each
other's tables, and until the writer is exercised as hard as the TypeScript one has
been, the honest scope is: read the index anyone can write, and prove the numbers
agree.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import datetime, timezone

from .models import Scope
from .query import group_by_bank, index_status, search_events
from .repo import banks as list_bank_names
from .repo import default_root


def _local(iso: str) -> str:
    """Storage is UTC, display is local — one formatter, or they drift.

    The reference implementation shipped a bug where `session` sliced the stored ISO
    while `dig` converted it, and the same session reported 10:06 and 17:06.
    """
    if not iso:
        return "never"
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return dt.astimezone().strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return iso[:16]


def _scope(a: argparse.Namespace) -> Scope:
    return Scope(data_root=getattr(a, "data_root", None),
                 in_repo=getattr(a, "in_repo", False),
                 repo=getattr(a, "repo", None), bank=getattr(a, "bank", None))


def _json(a: argparse.Namespace) -> bool:
    """--json is SUPPRESS-defaulted, so the attribute may simply not exist."""
    return bool(getattr(a, "json", False))


def cmd_status(a: argparse.Namespace) -> int:
    root, rows = index_status(_scope(a), freshness=not a.no_freshness)
    if not rows:
        print(f"no shards found in  {root}\n")
        print("  index one first:   relic index --since 7d   (TypeScript CLI)")
        return 1
    if _json(a):
        print(json.dumps({
            "root": root, "shards": len(rows),
            "events": sum(r.events for r in rows),
            "sessions": sum(r.sessions for r in rows),
            "rows": [r.model_dump() for r in rows],
        }, indent=2))
        return 0

    groups = group_by_bank(rows)
    print(f"layout  {root}/banks/<bank>/github.com/<org>/<repo>/")
    print("store   LanceDB + ICU full-text index (BM25)\n")
    # The legend is not decoration: it is the only place the two filter vocabularies
    # are stated, and they read two different columns of what follows.
    print("bank = the heading (exact) · repo = the indented column (substring)\n")
    for g in groups:
        print(f"  {g.bank}   {g.sessions:,} sessions · {g.events:,} events · {g.shards} shards")
        print(f"  {' ' * len(g.bank)}   indexed {_local(g.last_indexed)} · "
              f"newest session {_local(g.newest_session)}")
        for r in g.rows[:a.limit]:
            print(f"    {r.repo.replace('github.com/', ''):46} "
                  f"{r.sessions:>6} sess {r.events:>10,} ev")
        if len(g.rows) > a.limit:
            print(f"    ... and {len(g.rows) - a.limit} more (--limit N)")
        print()
    print(f"total   {sum(r.events for r in rows):,} events · "
          f"{sum(r.sessions for r in rows):,} sessions · {len(rows)} shards")
    print(f"last indexed  {_local(max((r.last_indexed for r in rows), default=''))}"
          f"   ·   newest session  {_local(max((r.newest_session for r in rows), default=''))}")
    return 0


def cmd_search(a: argparse.Namespace) -> int:
    q = " ".join(a.query).strip()
    if not q:
        print("search needs a query", file=sys.stderr)
        return 1
    res = search_events(q, _scope(a), limit=a.limit, all_tiers=a.all_tiers)
    if _json(a):
        print(json.dumps({**{k: res[k] for k in ("shards", "total", "ms")},
                          "hits": [h.model_dump() for h in res["hits"]]}, indent=2))
        return 0
    if not res["hits"]:
        print(f'no matches for "{q}" across {res["shards"]} shards ({res["ms"]} ms)')
        return 0
    narrowed = "" if a.all_tiers else "  ·  main sessions only — --all-tiers for subagent work"
    print(f'{len(res["hits"])} of {res["total"]} matches · {res["shards"]} shards · '
          f'{res["ms"]} ms{narrowed}\n')
    for h in res["hits"]:
        wt = f" [{h.worktree}]" if h.worktree else ""
        print(f"{h.repo}{wt} · {h.source}/{h.tier} · {h.role} · {h.ts}")
        snippet = " ".join(h.text.split())[:240]
        print(f"  ...{snippet}...")
        print(f"  relic show {h.file_path} --seq {int(h.seq)}\n")
    return 0


def cmd_banks(a: argparse.Namespace) -> int:
    names = list_bank_names(getattr(a, "data_root", None))
    if _json(a):
        print(json.dumps(names, indent=2))
        return 0
    if not names:
        print(f"no banks under {getattr(a, "data_root", None) or default_root()}")
        return 1
    for b in names:
        print(b)
    return 0



# ------------------------------------------------------------------ new commands

def cmd_sessions(a) -> int:
    from .query import list_sessions, name_of
    r = list_sessions(_scope(a), since=a.since, until=a.until,
                      worktree=a.worktree, limit=a.limit)
    if a.count:
        print(f"{r['total']} sessions · {r['events']:,} events")
        return 0
    if _json(a):
        print(json.dumps({"total": r["total"], "events": r["events"], "rows": r["rows"]},
                         indent=2, default=str))
        return 0
    if not r["total"]:
        print("no sessions match those filters")
        return 0
    print(f"{r['total']:,} sessions · {r['events']:,} events\n")
    for x in r["rows"]:
        print(f"{_local(x.get('started_at') or '')}  {str(x.get('session_uuid'))[:8]}  "
              f"{int(x.get('event_count') or 0):>6} ev  {x.get('repo', '')}"
              f"{' [' + x['worktree'] + ']' if x.get('worktree') else ''}")
        print(f"    {' '.join(name_of(x).split())[:110]}")
    if r["total"] > len(r["rows"]):
        print(f"\n... and {r['total'] - len(r['rows']):,} more (--limit N)")
    return 0


def cmd_session(a) -> int:
    from .query import name_of, neighbours, resolve_session, stats_of
    from .tree import build_tree, common_prefix, render_tree
    res = resolve_session(a.id, _scope(a), no_index=a.no_index)
    rows = res["rows"]
    if not rows:
        print(f"nothing matches {a.id} — tried it as an id, then as a name", file=sys.stderr)
        return 1
    uuids = {r.get("session_uuid") for r in rows}
    if res["matched_by"] == "name" and len(uuids) > 1:
        print(f"{len(uuids)} sessions named like \"{a.id}\" — call again with one id:\n")
        for r in rows:
            print(f"{_local(r.get('started_at') or '')}  {r.get('session_uuid')}  "
                  f"{int(r.get('event_count') or 0):>6} ev  {name_of(r)[:50]}")
        return 0

    st = stats_of(rows)
    parent = next((r for r in rows if r.get("tier") == "session"), rows[0])
    if _json(a):
        print(json.dumps({"stats": st, "rows": rows}, indent=2, default=str))
        return 0

    print(name_of(parent))
    print(f"{parent.get('session_uuid')} · matched by {res['matched_by']}"
          + (f" · {res['imported']} imported on demand" if res["imported"] else ""))
    print(f"{st['repo']}{' [' + st['worktree'] + ']' if st['worktree'] else ''}"
          + (f" · {st['model']}" if st["model"] else ""))
    print(f"{_local(st['started_at'])} → {_local(st['ended_at'])} · "
          f"{st['transcripts']:,} transcripts · {st['events']:,} events"
          + (f" · {st['runs']} workflow runs" if st["runs"] else ""))
    print("  " + " · ".join(f"{t} {n}" for t, n in st["tiers"]))

    if not a.no_neighbours:
        nb = neighbours(parent, _scope(a))
        if nb["before"] or nb["after"]:
            print("\nsame worktree, either side:")
            for r in nb["before"]:
                print(f"   {_local(r.get('started_at') or '')}  {str(r['session_uuid'])[:8]}  {name_of(r)[:60]}")
            print(f">> {_local(parent.get('started_at') or '')}  {str(parent['session_uuid'])[:8]}  {name_of(parent)[:60]}")
            for r in nb["after"]:
                print(f"   {_local(r.get('started_at') or '')}  {str(r['session_uuid'])[:8]}  {name_of(r)[:60]}")

    base = str(parent.get("file_path", "")).replace(".jsonl", "/")
    if a.tree:
        entries = [{
            "path": os.path.basename(r["file_path"]) if r["file_path"] == parent["file_path"]
                    else (r["file_path"][len(base):] if r["file_path"].startswith(base) else r["file_path"]),
            "label": f"{_local(r.get('started_at') or '')[-5:]} {r.get('tier')} {int(r.get('event_count') or 0):,} ev",
            "weight": int(r.get("event_count") or 0),
        } for r in rows]
        print(f"\n{base}")
        render_tree(build_tree(entries), "", a.limit)
        print(f"\n{len(rows):,} transcripts · {st['events']:,} events")
        return 0

    print(f"\ntranscripts (under {base}):")
    for r in rows[:a.limit]:
        p = r["file_path"] if r["file_path"] == parent["file_path"] else (
            r["file_path"][len(base):] if r["file_path"].startswith(base) else r["file_path"])
        print(f"  {_local(r.get('started_at') or '')[-5:]}  {str(r.get('tier')):<14} "
              f"{int(r.get('event_count') or 0):>6} ev  {p}")
    if len(rows) > a.limit:
        print(f"  ... and {len(rows) - a.limit} more (--limit N)")
    return 0


def cmd_show(a) -> int:
    from .query import read_around
    lines = read_around(a.file, a.seq, a.before, a.after)
    if not lines:
        print(f"no events around seq {a.seq} in {a.file}", file=sys.stderr)
        return 1
    if _json(a):
        print(json.dumps(lines, indent=2))
        return 0
    for l in lines:
        marker = ">>" if l["target"] else "  "
        print(f"{marker} #{l['seq']} {l['role']}: {' '.join(l['text'].split())[:1200]}")
    return 0


def cmd_pending(a) -> int:
    from .query import pending_report
    from .tree import build_tree, common_prefix, render_tree
    r = pending_report(_scope(a), corpus=a.corpus.split(",") if a.corpus else None,
                       since=a.since, list_n=a.list)
    if _json(a):
        print(json.dumps(r.model_dump(), indent=2, default=str))
        return 0
    print(f"found {r.found:,}  indexed {r.indexed:,}  missing {r.missing:,}  "
          f"changed {r.changed:,}   {r.scan_ms} ms")
    for g in r.groups:
        print(f"  {g.source + '/' + g.tier:<30} found {g.found:>6}  "
              f"missing {g.missing:>6}  changed {g.changed:>6}")
    if r.files and a.tree:
        root = common_prefix([x.path for x in r.files])
        entries = [{"path": x.path[len(root):] if x.path.startswith(root) else x.path,
                    "label": f"{x.state} {x.tier} {x.size:,}b", "weight": x.size}
                   for x in r.files]
        print(f"\n{root}")
        render_tree(build_tree(entries), "", a.limit, print, "b")
    elif r.files:
        print("\nnot indexed yet — newest first:\n")
        for x in r.files:
            print(f"{_local_epoch(x.mtime)}  {x.state:<7} {x.tier:<15} {x.session_id or '(none)'}")
            print(f"          {x.repo}  ·  bank {x.bank}  ·  {x.source}")
            if a.paths:
                print(f"          {x.path}")
    if r.files_omitted:
        print(f"\n... and {r.files_omitted:,} more pending (--list N)")
    return 0


def cmd_memory(a) -> int:
    from .query import memory_report
    m = memory_report(_scope(a), mem_type=a.mem_type, limit=a.limit)
    if _json(a):
        print(json.dumps(m, indent=2, default=str))
        return 0
    print(f"memories  {m['total']}")
    print("  " + "  ".join(f"{k}={v}" for k, v in sorted(m["by_type"].items(), key=lambda kv: -kv[1])))
    print(f"  with origin {m['with_origin']}   joined {m['joined']}   "
          f"orphaned {m['orphaned']}   no origin {m['no_origin']}\n")
    print(f"  {'repo':<42} {'mem':>5} {'transcripts':>12} {'producing':>10}")
    for r in m["repos"]:
        print(f"  {r['repo'].replace('github.com/', ''):<42} {r['mem']:>5} "
              f"{r['transcripts']:>12} {r['producing']:>10}")
    return 0


def cmd_now(a) -> int:
    from .live import current_session, human_age, live_sessions, tree_files
    if a.all:
        live = live_sessions(a.window, a.limit)
        if _json(a):
            print(json.dumps(live, indent=2, default=str))
            return 0
        if not live:
            print(f"nothing written in the last {human_age(a.window)}")
            return 0
        print(f"{len(live)} session(s) active in the last {human_age(a.window)}\n")
        for x in live:
            print(f"{human_age(x['age_sec']):>5} ago  {x['session_uuid'][:8]}  "
                  f"{x['agents']:>3} live agent(s)  {x['title'] or '(untitled)'}")
            print(f"            {x['cwd'] or x['project_dir']}")
        return 0

    cur = current_session(a.cwd)
    if not cur:
        print(f"no session transcript for {a.cwd or 'this directory'}")
        print("  relic-py now --all   to see every active session")
        return 1
    if _json(a):
        print(json.dumps(cur, indent=2, default=str))
        return 0
    files = tree_files(cur["project_dir"], cur["session_uuid"])
    agents = [f for f in files if f["tier"] != "session" and f["age_sec"] <= a.window]
    print(cur["title"] or "(untitled)")
    print(f"{cur['session_uuid']} · last write {human_age(cur['age_sec'])} ago")
    print(cur["cwd"] or "")
    print(f"{len(files)} transcripts in the tree\n")
    if agents:
        print(f"live agents (written in the last {human_age(a.window)}):")
        for f in agents[:a.limit]:
            print(f"  {human_age(f['age_sec']):>5} ago  {f['tier']:<14} {f['agent_id'] or ''}"
                  + (f"  {f['workflow_run_id']}" if f["workflow_run_id"] else ""))
    else:
        print(f"no agents running in the last {human_age(a.window)}")
    return 0


def cmd_sources(a) -> int:
    from .sources import bank_of, load_sources
    srcs = load_sources()
    if _json(a):
        print(json.dumps([{"key": s.key, "path": s.path, "walk": s.walk, "bank": bank_of(s),
                           "enabled": s.enabled, "present": os.path.exists(s.path),
                           "note": s.note} for s in srcs], indent=2))
        return 0
    print("configured sources (~/.relic/sources.json overrides)\n")
    banks = []
    for s in srcs:
        present = "present" if os.path.exists(s.path) else "MISSING"
        print(f"  [{'on ' if s.enabled else 'off'}] {s.key:<16} {present:<8} "
              f"bank={bank_of(s):<24} {s.path}")
        print(f"         {s.note}")
        if s.enabled and os.path.exists(s.path):
            banks.append(bank_of(s))
    print(f"\n  {len(set(banks))} banks would be written: " + " · ".join(dict.fromkeys(banks)))
    return 0


def cmd_index(a) -> int:
    from .discover import discover, parse_since
    from .importer import import_files
    only = a.corpus.split(",") if a.corpus and a.corpus != "all" else None
    since_ms = parse_since(a.since)
    t0 = time.time()
    print(f"🏺 relic indexing  ({only and '+'.join(only) or 'all enabled sources'} · "
          f"{'since ' + a.since if a.since else 'full history'}"
          f"{' · DRY RUN — no writes' if a.dry_run else ''})", file=sys.stderr)
    found = discover(only, since_ms)
    print(f"  scanned {len(found):,} files", file=sys.stderr)
    if a.dry_run:
        print("--dry-run: nothing written")
        return 0
    t = import_files(found, data_root=getattr(a, "data_root", None),
                     in_repo=getattr(a, "in_repo", False),
                     repo_filter=a.repo, progress=True, verbose=a.verbose)
    print(f"  scanned:     {len(found):,} files")
    print(f"  unchanged:   {t.skipped:,} (mtime+size match, never re-read)")
    print(f"  imported:    {t.imported:,} files -> {t.added:,} events")
    print(f"  shards:      {t.shards.size} (bank,repo) pairs, {t.fts_built} fts index "
          f"built in {t.fts_ms/1000:.1f}s")
    if t.failed:
        print(f"  failed:      {t.failed:,}")
    print(f"  wrote:       {getattr(a, 'data_root', None) or default_root()} "
          f"in {time.time()-t0:.1f}s")
    return 0


def cmd_shards(a) -> int:
    from .repo import list_shards
    shards = list_shards(getattr(a, "data_root", None), getattr(a, "in_repo", False))
    if a.bank:
        shards = [s for s in shards if s.bank == a.bank]
    if a.repo:
        shards = [s for s in shards if a.repo in s.repo]
    if a.count:
        print(len(shards))
        return 0
    if _json(a):
        print(json.dumps([s.model_dump() for s in shards], indent=2))
        return 0
    for s in shards:
        print(f"{s.key}\t{s.dir}")
    return 0


def main(argv: list[str] | None = None) -> int:
    # Global flags go on a PARENT parser that every subcommand inherits, not only on
    # the top-level one.
    #
    # argparse binds a top-level flag before the subcommand name and nowhere else, so
    # `relic-py status --json` exits 2 with "unrecognized arguments" while
    # `relic-py --json status` works. The TypeScript CLI accepts its flags in any
    # position, and this is meant to be the same app — a caller who writes
    # `relic status --json` and then `relic-py status --json` should not have to learn
    # that one of them puts flags somewhere else.
    #
    # It shipped because the check that would have caught it piped stderr to
    # /dev/null, so an exit-2 usage error read as an empty success.
    # default=SUPPRESS on every shared flag, and it is load-bearing.
    #
    # With an ordinary default, the SUBPARSER writes that default over whatever the
    # top-level parser already parsed — so adding parents=[common] fixed
    # `status --json` and simultaneously broke `--json status`, which had worked.
    # SUPPRESS means an absent flag sets no attribute at all, so the earlier value
    # survives and both placements work.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--data-root", default=argparse.SUPPRESS,
                        help="explicit index location")
    common.add_argument("--in-repo", action="store_true", default=argparse.SUPPRESS,
                        help="read <ghq>/<org>/<repo>/.relic")
    common.add_argument("--json", action="store_true", default=argparse.SUPPRESS,
                        help="machine output")

    p = argparse.ArgumentParser(
        prog="relic-py",
        parents=[common],
        description="relic, in Python — reads the same ~/.relic the TypeScript CLI writes",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("status", parents=[common],
                       help="bank -> repo, counts, and both clocks")
    s.add_argument("--bank"); s.add_argument("--repo")
    s.add_argument("--limit", type=int, default=15, help="repo rows per bank")
    s.add_argument("--no-freshness", action="store_true",
                   help="skip the two clocks (one less column scan per shard)")
    s.set_defaults(func=cmd_status)

    q = sub.add_parser("search", parents=[common],
                       help="full text, BM25-ranked, deduped across banks")
    q.add_argument("query", nargs="+")
    q.add_argument("--bank"); q.add_argument("--repo")
    q.add_argument("--limit", type=int, default=20)
    q.add_argument("--all-tiers", action="store_true")
    q.set_defaults(func=cmd_search)

    b = sub.add_parser("banks", parents=[common],
                       help="the bank names on this machine")
    b.set_defaults(func=cmd_banks)

    sh = sub.add_parser("shards", parents=[common], help="the index layout")
    sh.add_argument("--bank"); sh.add_argument("--repo")
    sh.add_argument("--count", action="store_true")
    sh.set_defaults(func=cmd_shards)

    ss = sub.add_parser("sessions", parents=[common],
                        help="what was I working on, over a time range")
    ss.add_argument("--bank"); ss.add_argument("--repo")
    ss.add_argument("--since"); ss.add_argument("--until"); ss.add_argument("--worktree")
    ss.add_argument("--count", action="store_true")
    ss.add_argument("--limit", type=int, default=40)
    ss.set_defaults(func=cmd_sessions)

    so = sub.add_parser("session", parents=[common],
                        help="one session by id OR name — its tree, stats, neighbours")
    so.add_argument("id")
    so.add_argument("--bank"); so.add_argument("--repo")
    so.add_argument("--limit", type=int, default=10)
    so.add_argument("--tree", action="store_true", help="render the tree, not a flat list")
    so.add_argument("--no-neighbours", action="store_true")
    so.add_argument("--no-index", action="store_true",
                    help="answer strictly from the index; do not seek on disk")
    so.set_defaults(func=cmd_session)

    sw = sub.add_parser("show", parents=[common],
                        help="the conversation around one event, from the source .jsonl")
    sw.add_argument("file"); sw.add_argument("--seq", type=int, required=True)
    sw.add_argument("--before", type=int, default=2)
    sw.add_argument("--after", type=int, default=2)
    sw.set_defaults(func=cmd_show)

    pe = sub.add_parser("pending", parents=[common],
                        help="on disk but NOT indexed — the only check that catches a partial index")
    pe.add_argument("--bank"); pe.add_argument("--repo")
    pe.add_argument("--corpus"); pe.add_argument("--since")
    pe.add_argument("--list", type=int, default=0, metavar="N")
    pe.add_argument("--paths", action="store_true")
    pe.add_argument("--tree", action="store_true")
    pe.add_argument("--limit", type=int, default=8)
    pe.set_defaults(func=cmd_pending)

    me = sub.add_parser("memory", parents=[common],
                        help="Claude's own memory, joined to the sessions that made it")
    me.add_argument("--bank"); me.add_argument("--repo")
    me.add_argument("--mem-type"); me.add_argument("--limit", type=int, default=20)
    me.set_defaults(func=cmd_memory)

    nw = sub.add_parser("now", parents=[common], help="what is running RIGHT NOW")
    nw.add_argument("--all", action="store_true")
    nw.add_argument("--cwd"); nw.add_argument("--window", type=int, default=300)
    nw.add_argument("--limit", type=int, default=15)
    nw.set_defaults(func=cmd_now)

    sr = sub.add_parser("sources", parents=[common],
                        help="what this machine has, and what is on/off")
    sr.set_defaults(func=cmd_sources)

    ix = sub.add_parser("index", parents=[common], help="build or update the index")
    ix.add_argument("--corpus"); ix.add_argument("--since"); ix.add_argument("--repo")
    ix.add_argument("--dry-run", action="store_true")
    ix.add_argument("--verbose", action="store_true")
    ix.set_defaults(func=cmd_index)

    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    raise SystemExit(main())
