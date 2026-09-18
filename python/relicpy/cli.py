"""relic-py — the reference CLI's read surface, over the same index.

Deliberately a READER. Indexing is where the two implementations could corrupt each
other's tables, and until the writer is exercised as hard as the TypeScript one has
been, the honest scope is: read the index anyone can write, and prove the numbers
agree.
"""

from __future__ import annotations

import argparse
import json
import sys
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

    a = p.parse_args(argv)
    return a.func(a)


if __name__ == "__main__":
    raise SystemExit(main())
