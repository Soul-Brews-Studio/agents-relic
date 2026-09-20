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


def _fmt(a: argparse.Namespace) -> str:
    """Output mode. plain and jsonl are line-oriented so they compose with the shell."""
    if _json(a):
        return "json"
    if getattr(a, "jsonl", False):
        return "jsonl"
    if getattr(a, "plain", False):
        return "plain"
    return "pretty"


def _json(a: argparse.Namespace) -> bool:
    """--json is SUPPRESS-defaulted, so the attribute may simply not exist."""
    return bool(getattr(a, "json", False))


def cmd_embed(a: argparse.Namespace) -> int:
    """A second pass over an index that is already complete.

    Deliberately not part of `index`. The measured result on this corpus is that the
    full-text index WINS (MRR@20 0.890 vs 0.600 for the best of three models, bench/),
    so embedding is opt-in, resumable, and scoped — and --dry-run answers "how much
    would this cost" without a single call to the provider.
    """
    from .embed import embed_shards      # imported here so `relic-py --help` never
                                         # touches an optional model runtime

    main_tiers = not a.all_tiers
    last = [0]
    drew = [False]

    def progress(key: str, done: int, total: int) -> None:
        if _fmt(a) != "pretty" or done - last[0] < 200:
            return
        last[0] = done
        drew[0] = True
        sys.stderr.write(f"\r  {key}  {done:,}/{total:,}   ")

    try:
        t = embed_shards(_scope(a), provider=a.provider, model=a.model, host=a.host,
                         device=a.device, batch=a.batch, limit=a.limit,
                         main_tiers=main_tiers, min_chars=a.min_chars,
                         max_chars=a.max_chars, dry_run=a.dry_run, reset=a.reset,
                         on_progress=progress)
    except (ValueError, RuntimeError) as e:
        # A bad --provider or a missing optional dependency is a usage error, not a
        # traceback: the message already says what to run instead.
        print(str(e), file=sys.stderr)
        return 2
    # Only erase a line that was actually drawn — clearing unconditionally writes 78
    # spaces into a terminal that never showed progress, which lands as indentation in
    # front of the first line of output.
    if drew[0]:
        sys.stderr.write("\r" + " " * 78 + "\r")

    if _json(a):
        print(json.dumps({"provider": t.provider_id, "dryRun": t.dry_run,
                          "embedded": t.embedded, "pending": t.pending,
                          "failed": t.failed, "ms": t.ms,
                          "shards": [vars(x) for x in t.shards]}, indent=2))
        return 0

    touched = [x for x in t.shards if x.eligible > 0 or x.skipped]
    if not touched:
        # Two different nothings. Reporting them as one sends the reader chasing a
        # --bank typo when the filter is doing exactly its job.
        if not t.shards:
            print("no shards match — check --repo / --bank, or run relic index first")
        else:
            print(f"{len(t.shards)} shards matched, but nothing is eligible: no event "
                  f"passes {'the main-tiers filter' if main_tiers else 'the filter'} "
                  f"at >= {a.min_chars} chars.")
            if main_tiers:
                print("(a memory or subagent bank is all non-main kinds — try --all-tiers)")
        return 1

    print(f"provider  {t.provider_id}" + ("   (dry run — nothing written)" if t.dry_run else ""))
    print(f"scope     {'main tiers' if main_tiers else 'all tiers'}, "
          f"text >= {a.min_chars} chars, truncated at {a.max_chars}\n")
    w = max([6] + [len(x.key) for x in touched])
    for x in touched[: a.limit or 40]:
        if x.skipped:
            print(f"  {x.key:<{w}}  SKIP  {x.skipped}")
            continue
        cov = round((x.already + x.embedded) / x.eligible * 100) if x.eligible else 0
        line = (f"  {x.key:<{w}}  {cov:>3}%  "
                f"{x.already + x.embedded:,}/{x.eligible:,} embedded")
        if x.embedded:
            line += f"  +{x.embedded:,} this run"
        if x.pending and t.dry_run:
            line += f"  {x.pending:,} pending"
        if x.failed:
            line += f"  {x.failed:,} FAILED"
        if x.dim:
            line += f"  dim {x.dim}"
        print(line)
    secs = t.ms / 1000
    rate = f"  ({t.embedded / secs:.0f}/s)" if t.embedded and secs > 0 else ""
    print(f"\n{t.embedded:,} embedded · {t.pending:,} pending · {t.failed:,} failed"
          f" · {len(touched)} shards · {secs:.1f}s{rate}")
    if t.dry_run:
        print("\nre-run without --dry-run to write. Vectors go to the per-shard "
              "`vectors`\ntable; `events` and the full-text index are untouched.")
    return 0


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


def _local_epoch(sec: float) -> str:
    """Epoch seconds -> local "YYYY-MM-DD HH:MM", matching the TypeScript CLI.

    This function did not exist while two call sites used it, so `relic-py pending
    --list N` raised NameError on its first pending file — for every release. The
    command "ran" (exit 0, counts printed) whenever nothing was pending, which is the
    state a parity check that only compares summaries would find.
    """
    return datetime.fromtimestamp(sec).astimezone().strftime("%Y-%m-%d %H:%M")


def _tilde_home(p: str) -> str:
    """`/Users/x/...` -> `~/...`. A cwd is long and its prefix is the least useful part."""
    h = os.path.expanduser("~")
    return "~" + p[len(h):] if p and p.startswith(h + "/") else p


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
    # "is anything pending, and how recent" is one question; the TypeScript CLI has
    # always answered the second half and this one silently dropped it.
    if r.newest_pending_ms:
        print(f"newest pending file: {_local_epoch(r.newest_pending_ms / 1000)}")
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
        # Same columns and same second line as the TypeScript CLI. Two readers of one
        # index that format the same report differently is a parity gap a user hits
        # before any test does.
        print("\nnot indexed yet — newest first (name, cwd and repo read from each transcript):\n")
        print(f"  {'when':<17} {'session':<10} {'state':<8} {'source/tier':<26} repo")
        for x in r.files:
            sid = x.session_id[:8] if x.session_id else "-"
            print(f"  {_local_epoch(x.mtime):<17} {sid:<10} {x.state:<8} "
                  f"{x.source + '/' + x.tier:<26} {x.repo}")
            # name_of returns "(untitled)" when a transcript wrote no title and no
            # usable description; printing that in quotes reads as a real name.
            named = f'"{x.name[:60]}"' if x.name and x.name != "(untitled)" else ""
            bits = [b for b in (named, _tilde_home(x.cwd)) if b]
            if bits:
                print(f"  {'':<17} {'   '.join(bits)}")
            if a.paths:
                print(f"  {'':<17} {x.path}")
    elif r.missing + r.changed == 0:
        print("\nnothing pending — every discovered file is in the index.")
    if r.files_omitted:
        print(f"\n  ... and {r.files_omitted:,} more pending (--list N)")
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

    # Opt-in, never implicit. The import just resolved every discovered file to its
    # shard, so pruning here costs one query per shard and no second parse pass.
    if getattr(a, "prune", False):
        from .prune import prune, DEFAULT_MAX_DROP_PCT
        max_drop = getattr(a, "max_drop", None)
        max_drop = DEFAULT_MAX_DROP_PCT if max_drop is None else float(max_drop)
        plan = prune(t, apply=True, max_drop_pct=max_drop, force=getattr(a, "force", False),
                     data_root=getattr(a, "data_root", None),
                     in_repo=getattr(a, "in_repo", False),
                     since_ms=since_ms, repo_filter=a.repo)
        _report_prune(plan, max_drop)
    return 0


def _drop_shapes(paths: list[str], top: int = 3) -> str:
    """The drop set by filename, commonest first.

    A refusal that says only "72.7%" gives a human no way to decide whether --force is
    safe. Measured on the live index: both refused `_unresolved` shards were 100% ONE
    filename — journal.jsonl, the exact rows prune was built to remove — and the
    percentage alone hid that completely.
    """
    from collections import Counter
    by = Counter(p.rsplit("/", 1)[-1] for p in paths)
    head = ", ".join(f"{n:,}x {b}" for b, n in by.most_common(top))
    return head + (f", +{len(by) - top} more names" if len(by) > top else "")


def _report_prune(plan, max_drop_pct: float) -> None:
    """Print a prune plan. Same renderer for the dry run and the applied one — the only
    difference in the output is the verb, because the only difference in the run is
    whether `delete` was called."""
    from .prune import prune_totals
    if plan.refused:
        print(f"\n  prune REFUSED — {plan.refused}")
        return
    tot = prune_totals(plan)
    verb = "removed" if plan.applied else "would remove"
    print(f"\nprune ({'APPLIED' if plan.applied else 'dry run — nothing written'})")
    for sh in plan.shards:
        if not sh.drop and not sh.blocked:
            continue
        name = f"{sh.bank}/{sh.repo}"
        if sh.blocked:
            print(f"  ⚠ {name}")
            print(f"      SKIPPED — {sh.blocked}. {len(sh.drop):,} of {sh.indexed:,} files.")
            print(f"      they are: {_drop_shapes(sh.drop)}")
            print("      --force prunes it anyway; check the source root is fully readable first.")
            continue
        r = sh.removed or {}
        print(f"  {name}")
        print(f"      {verb} {len(sh.drop):,} of {sh.indexed:,} files ({sh.drop_pct:.1f}%)"
              f"  {r.get('events', 0):,} events  {r.get('sessions', 0):,} sessions"
              + (f"  {r['vectors']:,} vectors" if r.get("vectors") else ""))
        for d in sh.drop[:3]:
            print(f"        {d}")
        if len(sh.drop) > 3:
            print(f"        … {len(sh.drop) - 3:,} more")
    if not tot["files"] and not tot["blocked"]:
        print("  nothing to prune — every indexed file is still discoverable.")
    print(f"\n  {verb}: {tot['files']:,} file{'' if tot['files'] == 1 else 's'}  "
          f"{tot['events']:,} events  "
          f"{tot['sessions']:,} sessions  {tot['vectors']:,} vectors  "
          f"across {tot['shards']} shard{'' if tot['shards'] == 1 else 's'}")
    if tot["blocked"]:
        print(f"  ⚠ {tot['blocked']} shard{'' if tot['blocked'] == 1 else 's'} refused by "
              f"the {max_drop_pct:g}% ceiling — see --force")
    # "nothing to prune" and "never looked" are different facts. Only one means clean.
    if plan.untouched:
        print(f"  {plan.untouched} shard{'' if plan.untouched == 1 else 's'} on disk were "
              "not reached by this run — never considered")
    if not plan.applied and tot["files"]:
        print("\n  to remove them:  relic prune --apply")


def cmd_prune(a) -> int:
    """Scan every source, then remove index rows for files discovery no longer yields.

    DRY BY DEFAULT. `--apply` is the only thing that deletes, and the preview it prints
    comes from the same call with the flag flipped, so the number approved is the
    number executed.
    """
    from .discover import discover
    from .importer import import_files
    from .prune import prune, DEFAULT_MAX_DROP_PCT

    # --since/--repo would silently change WHAT WAS SCANNED, so reject them before the
    # scan rather than refusing after it.
    if getattr(a, "since", None) or a.repo:
        print("prune cannot take --since or --repo — a narrowed scan makes every file "
              "outside it look deleted.", file=sys.stderr)
        print("prune always scans in full; use --corpus to limit which BANKS are eligible.",
              file=sys.stderr)
        return 1
    max_drop = getattr(a, "max_drop", None)
    max_drop = DEFAULT_MAX_DROP_PCT if max_drop is None else float(max_drop)
    if not (0 <= max_drop <= 100):
        print(f"--max-drop must be a percentage between 0 and 100 (got {max_drop:g})",
              file=sys.stderr)
        return 1

    only = a.corpus.split(",") if a.corpus and a.corpus != "all" else None
    apply_it = bool(getattr(a, "apply", False))
    t0 = time.time()
    print(f"🏺 relic prune  ({only and '+'.join(only) or 'all enabled sources'} · "
          f"{'APPLY — rows will be deleted' if apply_it else 'dry run'} · "
          f"ceiling {max_drop:g}%)", file=sys.stderr)
    found = discover(only, None)
    t = import_files(found, data_root=getattr(a, "data_root", None),
                     in_repo=getattr(a, "in_repo", False),
                     progress=True, verbose=a.verbose, no_write=True)
    print(f"  scanned:     {len(found):,} files -> {len(t.seen)} shards reached")
    if t.failed:
        print(f"  ⚠ failed:    {t.failed:,} (re-run with --verbose to see why)")

    plan = prune(t, apply=apply_it, max_drop_pct=max_drop, force=getattr(a, "force", False),
                 data_root=getattr(a, "data_root", None),
                 in_repo=getattr(a, "in_repo", False), since_ms=None, repo_filter=None)
    _report_prune(plan, max_drop)
    print(f"  {time.time()-t0:.1f}s")
    return 1 if plan.refused else 0


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



def cmd_chain(a) -> int:
    from .chain import build_chain, render_chain
    from .query import resolve_session
    res = resolve_session(a.id, _scope(a), no_index=a.no_index)
    if not res["rows"]:
        print(f"no session matches {a.id}", file=sys.stderr)
        return 1
    c = build_chain(a.id, res["rows"])
    if _json(a):
        print(json.dumps({"id": c.id, "total": c.total, "wall_ms": c.wall_ms,
                          "work_ms": c.work_ms,
                          "groups": [{"run": g.run, "rows": len(g.rows), "peak": g.peak,
                                      "start_ms": g.start_ms, "end_ms": g.end_ms}
                                     for g in c.groups]}, indent=2))
        return 0
    if res["imported"]:
        print(f"({res['imported']} transcripts imported on demand)\n")
    print(render_chain(c, a.width, a.limit))
    return 0


def cmd_read(a) -> int:
    from .sources import parser_for
    from .time import local_date_time
    parsed = parser_for(a.file)(a.file)
    rows = [e for e in parsed.events
            if (not a.role or e.role == a.role)
            and (not a.prose or e.role in ("user", "assistant", "thinking", "note"))]
    mode = _fmt(a)
    if mode == "json":
        print(json.dumps({"file": a.file, "title": parsed.title,
                          "events": [e.model_dump() for e in rows]}, indent=2, default=str))
    elif mode == "jsonl":
        for e in rows:
            print(json.dumps(e.model_dump(), default=str))
    elif mode == "plain":
        for e in rows:
            print(f"{e.seq}\t{e.role}\t{' '.join(e.text.split())}")
    else:
        if parsed.title:
            print(f"{parsed.title}\n")
        for e in rows:
            print(f"#{e.seq:>4} {e.role}" + (f"  {local_date_time(e.ts)}" if e.ts else ""))
            print("\n".join("  " + l for l in e.text.split("\n")))
            print()
    return 0


def cmd_trace(a) -> int:
    from .repo import list_shards
    from .trace import read_trace
    known = [s.repo for s in list_shards(getattr(a, "data_root", None))]
    t = read_trace(getattr(a, "data_root", None), known)
    if not t:
        print("no query log yet — run a search first")
        return 0
    if _json(a):
        print(json.dumps(t, indent=2))
        return 0
    print(f"{t['total']} queries · {t['span']} · median {t['median_ms']} ms\n")
    print("answered by (top hit's repo)")
    for r in t["by_repo"][:a.limit]:
        print(f"  {r['n']:>5}  {r['repo']}")
    print(f"\nzero-hit queries: {t['zero_hit']}/{t['total']}")
    if t["fts_misses"]:
        # A LIKE fallback is 7-28x slower and unranked, so it is worth surfacing.
        print(f"fts fallbacks:    {t['fts_misses']}  (LIKE scan — slower, no _score)")
    print("slowest")
    for r in t["slowest"]:
        print(f"  {r['ms']:>6} ms  {r['q'][:60]}")
    if t["dead_shards"]:
        print(f"\n{len(t['dead_shards'])} of {len(known)} shards have never produced a best hit")
    return 0


def cmd_skipped(a) -> int:
    from .noise import read_skipped
    r = read_skipped(getattr(a, "data_root", None), a.limit)
    if _json(a):
        print(json.dumps(r, indent=2))
        return 0
    if not r["total"]:
        print("nothing dropped yet — --skip-noise is opt-in, and every drop is logged here")
        return 0
    print(f"{r['total']:,} events dropped · {r['bytes']/1e6:.2f} MB\n")
    for b in r["by_rule"]:
        print(f"  {b['rule']:<22} {b['n']:>7}  {b['bytes']/1e6:>7.2f} MB")
    print("\nmost recent:")
    for x in r["rows"]:
        print(f"  {x.get('rule','?'):<22} {str(x.get('head',''))[:80]}")
    return 0


def cmd_backend(a) -> int:
    """Python has no native binary — say so plainly rather than implying one exists."""
    import platform
    info = {
        "implementation": "python", "runtime": platform.python_version(),
        "engine": "lancedb (the same Rust core every front end wraps)",
        "native_binary": None,
        "note": "the optional relic-native binary accelerates the TypeScript live scan; "
                "relicpy has no equivalent and does not shell out to it",
    }
    if _json(a):
        print(json.dumps(info, indent=2))
        return 0
    for k, v in info.items():
        print(f"  {k:<16} {v}")
    return 0


def cmd_mcp(a) -> int:
    from .mcp import serve
    return serve()


def cmd_dig(a) -> int:
    """Session timeline as JSON — dig.py's contract, all three tiers.

    Built from the INDEX rather than by re-walking, which is the whole point: the
    third tier (workflow_agent) is one directory deeper than an obvious glob reaches.
    """
    from .query import list_sessions, name_of
    r = list_sessions(_scope(a), since=a.since, limit=a.count)
    out = [{
        "sessionId": str(x.get("session_uuid"))[:12],
        "repoName": str(x.get("repo") or "").split("/")[-1],
        "startGMT7": _local(x.get("started_at") or ""),
        "endGMT7": _local(x.get("ended_at") or ""),
        "events": int(x.get("event_count") or 0),
        "tier": x.get("tier"),
        "gitBranch": x.get("git_branch") or "",
        "summary": name_of(x),
    } for x in r["rows"]]
    print(json.dumps(out, indent=2, ensure_ascii=False))
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
    # default None, NOT 0: absent means "decide for me", which pending_report
    # answers by listing a small pending set and capping a large one. 0 still
    # means "list nothing", and the two are different requests.
    pe.add_argument("--list", type=int, default=None, metavar="N")
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

    lv = sub.add_parser("live", parents=[common], help="alias for `now`")
    lv.add_argument("--all", action="store_true")
    lv.add_argument("--cwd"); lv.add_argument("--window", type=int, default=300)
    lv.add_argument("--limit", type=int, default=15)
    lv.set_defaults(func=cmd_now)

    sr = sub.add_parser("sources", parents=[common],
                        help="what this machine has, and what is on/off")
    sr.set_defaults(func=cmd_sources)


    ch = sub.add_parser("chain", parents=[common],
                        help="the session tree on a TIME axis — what ran in parallel")
    ch.add_argument("id")
    ch.add_argument("--bank"); ch.add_argument("--repo")
    ch.add_argument("--width", type=int, default=40)
    ch.add_argument("--limit", type=int, default=8)
    ch.add_argument("--no-index", action="store_true")
    ch.set_defaults(func=cmd_chain)

    rd = sub.add_parser("read", parents=[common],
                        help="a whole transcript as readable conversation, any shape")
    rd.add_argument("file")
    rd.add_argument("--role"); rd.add_argument("--prose", action="store_true")
    rd.add_argument("--jsonl", action="store_true"); rd.add_argument("--plain", action="store_true")
    rd.set_defaults(func=cmd_read)

    tr = sub.add_parser("trace", parents=[common],
                        help="your own query log: who answers, what is dead")
    tr.add_argument("--limit", type=int, default=10)
    tr.set_defaults(func=cmd_trace)

    sk = sub.add_parser("skipped", parents=[common],
                        help="what --skip-noise dropped, and the proof")
    sk.add_argument("--limit", type=int, default=20)
    sk.set_defaults(func=cmd_skipped)

    bk = sub.add_parser("backend", parents=[common],
                        help="which engine answers what, in this implementation")
    bk.set_defaults(func=cmd_backend)

    dg = sub.add_parser("dig", parents=[common],
                        help="session timeline as JSON — dig.py's contract, all 3 tiers")
    dg.add_argument("count", nargs="?", type=int, default=10)
    dg.add_argument("--bank"); dg.add_argument("--repo"); dg.add_argument("--since")
    dg.set_defaults(func=cmd_dig)

    mc = sub.add_parser("mcp", parents=[common],
                        help="run the MCP server on stdio (same lookups, for a model)")
    mc.set_defaults(func=cmd_mcp)

    em = sub.add_parser("embed", parents=[common],
                        help="opt-in second pass: write a per-shard `vectors` table")
    em.add_argument("--bank"); em.add_argument("--repo")
    em.add_argument("--provider", default="ollama", choices=["ollama", "st"],
                    help="ollama (default, no extra deps) or st (sentence-transformers)")
    em.add_argument("--model", default="all-minilm")
    em.add_argument("--host", default=None, help="ollama base URL")
    em.add_argument("--device", default=None, help="st only: cpu | mps | cuda")
    em.add_argument("--batch", type=int, default=64)
    em.add_argument("--limit", type=int, default=None, help="cap per shard, not total")
    em.add_argument("--all-tiers", action="store_true",
                    help="include subagent/workflow/memory, not just the main thread")
    em.add_argument("--min-chars", type=int, default=24)
    em.add_argument("--max-chars", type=int, default=2000)
    em.add_argument("--dry-run", action="store_true",
                    help="count what would be embedded; no call to the provider")
    em.add_argument("--reset", action="store_true",
                    help="drop `vectors` first — the only way to change model or dim")
    em.set_defaults(func=cmd_embed)

    pr = sub.add_parser("prune", parents=[common],
                        help="remove index rows for files discovery no longer yields")
    pr.add_argument("--apply", action="store_true",
                    help="actually delete; without it this is a dry run")
    pr.add_argument("--corpus", help="limit which BANKS are eligible")
    # --repo and --since exist here ONLY so the guard can name them. A narrowed scan
    # makes every file outside it look deleted; argparse rejecting them as unknown
    # would print "unrecognized arguments" and teach nothing.
    pr.add_argument("--repo"); pr.add_argument("--since")
    pr.add_argument("--verbose", action="store_true")
    pr.add_argument("--max-drop", dest="max_drop", type=float,
                    help="refuse any shard losing more than this percent (default 10)")
    pr.add_argument("--force", action="store_true", help="ignore the --max-drop ceiling")
    pr.set_defaults(func=cmd_prune)

    ix = sub.add_parser("index", parents=[common], help="build or update the index")
    ix.add_argument("--corpus"); ix.add_argument("--since"); ix.add_argument("--repo")
    ix.add_argument("--dry-run", action="store_true")
    ix.add_argument("--verbose", action="store_true")
    ix.add_argument("--prune", action="store_true",
                    help="after importing, remove rows for files discovery no longer "
                         "yields (refused unless the run was unfiltered and clean)")
    ix.add_argument("--max-drop", dest="max_drop", type=float,
                    help="refuse any shard losing more than this percent (default 10)")
    ix.add_argument("--force", action="store_true", help="ignore the --max-drop ceiling")
    ix.set_defaults(func=cmd_index)

    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    raise SystemExit(main())
