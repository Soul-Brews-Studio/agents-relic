"""Removing rows the index should no longer hold.

The importer only ever adds and updates. A file that stops being discoverable — a new
skip rule excluded it, it was deleted, it moved — keeps its `events`, `sessions` and
`files` rows forever. Measured on the live index before this existed: 1,353
`journal.jsonl` rows for a file discovery has skipped since 2026-09-18, which made
EVERY session tree containing a workflow report one transcript too many. Two resolvers
were taught to filter journal.jsonl out rather than fix this — two workarounds for one
absent feature.

THIS IS THE ONLY CODE IN RELIC THAT DELETES ROWS A HUMAN DID NOT NAME, so the whole
design is the scoping. The naive version — "drop rows whose file_path was not seen this
run" — destroys the index on any normal invocation, because a narrowed scan is the
normal case: `--since 7d` cannot see a file older than seven days, and `--repo` never
parses most of the corpus at all.

Four gates, from widest to narrowest:

  1. the run must be UNFILTERED — no --since, no --repo
  2. nothing may have FAILED to parse; a file that failed is not a file that is gone
  3. only shards this run actually reached are considered — a bank whose source was not
     in --corpus, or whose root was missing, is never touched
  4. a shard losing more than `max_drop_pct` of its files is REFUSED, not pruned

Gate 4 is not paranoia, it is a bug that already happened. `ghq.root` was unset on
white.local, so `resolve_repo_key` returned None for everything and every file resolved
to `_unresolved` — under gates 1-3 alone that reads as "every real shard lost all its
files" and prunes the entire index while printing a clean summary.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

from .importer import ImportTally
from .repo import list_shards

DEFAULT_MAX_DROP_PCT = 10.0


@dataclass
class ShardPrune:
    bank: str
    repo: str
    indexed: int
    discovered: int
    drop: list[str]
    drop_pct: float
    blocked: Optional[str] = None
    removed: Optional[dict[str, int]] = None


@dataclass
class PrunePlan:
    refused: Optional[str] = None
    shards: list[ShardPrune] = field(default_factory=list)
    # Shards on disk this run never reached. Not a failure — the conservative case.
    untouched: int = 0
    applied: bool = False


def prune_refusal(t: ImportTally, since_ms: Optional[int], repo_filter: Optional[str]) -> Optional[str]:
    """Why this run may not prune, or None."""
    if since_ms is not None:
        return ("--since narrows discovery to recent files, so every older file would "
                "look deleted. Prune needs a full scan.")
    if repo_filter:
        return ("--repo narrows discovery to one repo, so every other repo would look "
                "deleted. Prune needs a full scan.")
    if t.failed:
        return (f"{t.failed:,} file{'' if t.failed == 1 else 's'} failed to parse. A file "
                "that failed to parse is not a file that is gone — re-run with --verbose, "
                "fix it, then prune.")
    return None


def prune(t: ImportTally, *, apply: bool, max_drop_pct: float = DEFAULT_MAX_DROP_PCT,
          force: bool = False, data_root: Optional[str] = None, in_repo: bool = False,
          since_ms: Optional[int] = None, repo_filter: Optional[str] = None) -> PrunePlan:
    """Compare discovery against the index and, if `apply`, remove the difference.

    The dry run and the real run are the SAME call with a flag, down into
    `LanceStore.prune_files` — so the count a human approved is produced by the code
    that executes, not by a second query that resembles it.
    """
    refused = prune_refusal(t, since_ms, repo_filter)
    if refused:
        return PrunePlan(refused=refused)

    # ONE GLOBAL SET, not one per shard — a file that MOVED shard is still on disk.
    #
    # Measured on the live index: two memory files sat in `memory/_unresolved` and now
    # resolve to `memory/github.com/laris-co/neo-oracle`, because a memory note takes
    # its cwd from the session that produced it and that session had not been indexed
    # yet when the note was first written. Comparing per shard reads that as "deleted"
    # — and a prune-only run writes no replacement row, so the file would be on disk
    # with nothing in the index pointing at it.
    #
    # Keeping the stale row is the safe failure: uid already collapses duplicates at
    # read time. Deleting it loses the only copy. Shard migration is a different
    # feature; prune must not do it by accident.
    everywhere: set[str] = set()
    for v in t.seen.values():
        everywhere |= v

    out: list[ShardPrune] = []
    for shard_key, discovered in t.seen.items():
        store = t.shards.by_key(shard_key) if t.shards else None
        if store is None:                  # cannot happen: seen is filled beside the pool
            continue
        bank, repo = shard_key
        indexed = store.indexed_files()
        drop = sorted(p for p in indexed if p not in everywhere)
        drop_pct = (len(drop) / len(indexed) * 100) if indexed else 0.0

        blocked = None
        if drop and drop_pct > max_drop_pct and not force:
            blocked = f"would drop {drop_pct:.1f}% of this shard (ceiling {max_drop_pct:g}%)"

        removed = store.prune_files(drop, apply) if (drop and not blocked) else None
        out.append(ShardPrune(bank=bank, repo=repo, indexed=len(indexed),
                              discovered=len(discovered), drop=drop, drop_pct=drop_pct,
                              blocked=blocked, removed=removed))

    # "nothing to prune" and "never looked" are different facts. Only one means clean.
    reached = set(t.seen.keys())
    untouched = sum(1 for s in list_shards(data_root, in_repo) if (s.bank, s.repo) not in reached)
    return PrunePlan(refused=None, shards=out, untouched=untouched, applied=apply)


def prune_totals(plan: PrunePlan) -> dict[str, int]:
    """Totals across a plan — the numbers a summary line quotes."""
    tot = {"files": 0, "events": 0, "sessions": 0, "vectors": 0, "shards": 0, "blocked": 0}
    for s in plan.shards:
        if s.blocked:
            tot["blocked"] += 1
            continue
        if not s.drop:
            continue
        tot["shards"] += 1
        tot["files"] += len(s.drop)
        for k in ("events", "sessions", "vectors"):
            tot[k] += (s.removed or {}).get(k, 0)
    return tot
