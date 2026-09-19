"""Writing into the index.

Lives apart from cli.py because `session`, `chain` and the MCP server all need the
SEEK -> INDEX -> ANSWER path, and cli.py runs a command at import time — anything that
imported it to reuse one function would execute the CLI as a side effect.
"""

from __future__ import annotations

import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from .discover import Found
from .models import DEFAULT_BANK, EventRow, FileRow, SessionRow
from .repo import context_of, location_of, repo_key_of, shard_dir_for, resolve_repo_key
from .store import LanceStore


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def kind_of(tier: str, source: str) -> str:
    """The second axis, split out of `tier`. Source decides before tier, because
    hermes rows carry tier "session" while being chat messages."""
    if source.startswith("hermes"):
        return "message"
    if tier == "note":
        return "note"
    if tier == "memory":
        return "memory"
    return "transcript"


class Shards:
    """One store per (BANK, repo), opened on first write.

    Keying on the repo alone would hand the same store to two banks and every row
    would land in whichever opened first — silently, since both writes succeed. The
    three Claude roots overlap by 742 sessions, so that is not hypothetical.
    """

    def __init__(self, data_root: Optional[str], in_repo: bool = False):
        self.data_root = data_root
        self.in_repo = in_repo
        self._pool: dict[tuple[str, str], LanceStore] = {}

    def get(self, repo_key: Optional[str], bank: str = DEFAULT_BANK) -> LanceStore:
        key = (bank, repo_key or "_unresolved")
        st = self._pool.get(key)
        if st is None:
            st = LanceStore.open(shard_dir_for(repo_key, self.data_root, self.in_repo, bank))
            self._pool[key] = st
        return st

    @property
    def size(self) -> int:
        return len(self._pool)

    def stores(self) -> list[LanceStore]:
        return list(self._pool.values())


@dataclass
class ImportTally:
    added: int = 0
    skipped: int = 0
    failed: int = 0
    filtered: int = 0
    done: int = 0
    imported: int = 0
    fts_built: int = 0
    fts_failed: int = 0
    fts_ms: int = 0
    shards: Optional[Shards] = None


@dataclass
class _Pending:
    store: LanceStore
    events: list[EventRow] = field(default_factory=list)
    sessions: list[SessionRow] = field(default_factory=list)
    files: list[FileRow] = field(default_factory=list)
    deletes: list[str] = field(default_factory=list)


# Each merge_insert is a versioned commit. Writing per FILE means 3 commits per file,
# negligible for transcripts (few files, thousands of events) and pathological for
# document sources (many files, ~1 event each). Measured before batching:
# oracle-vault 10,058 files at 5 files/sec, ETA 32 min.
FLUSH_EVERY = 250


def import_files(found: list[Found], *, data_root: Optional[str] = None,
                 in_repo: bool = False, repo_filter: Optional[str] = None,
                 progress: bool = False, verbose: bool = False) -> ImportTally:
    shards = Shards(data_root, in_repo)
    manifests: dict[tuple[str, str], dict] = {}
    t = ImportTally(shards=shards)
    pending: dict[tuple[str, str], _Pending] = {}
    t0 = time.time()

    def flush() -> None:
        for b in pending.values():
            if not (b.events or b.sessions or b.files or b.deletes):
                continue
            # Deletes FIRST and as a unit: a re-imported file must drop its old rows
            # before the new ones land, or the two generations coexist.
            for fp in b.deletes:
                b.store.delete_events_of(fp)
            if b.events:
                b.store.put_events(b.events)
            if b.sessions:
                b.store.put_sessions(b.sessions)
            if b.files:
                b.store.put_files(b.files)
            b.events, b.sessions, b.files, b.deletes = [], [], [], []

    since_flush = 0
    for f in found:
        try:
            p = f.parser(f.path)
            repo_key = resolve_repo_key(p.cwd)
            if repo_filter and repo_filter not in (repo_key or ""):
                t.filtered += 1
                continue

            # `repo_col` goes in the rows; the batch key is (bank, repo). The bank is
            # NOT written into repo_key — it is already the directory the row lives in,
            # and duplicating it would make every `--repo` filter match bank names too.
            repo_col = repo_key or "_unresolved"
            shard_key = (f.bank, repo_col)
            ctx, loc = context_of(p.cwd), location_of(p.cwd)
            store = shards.get(repo_key, f.bank)

            if shard_key not in manifests:
                manifests[shard_key] = store.manifest()
            man = manifests[shard_key]
            seen = man.get(f.path)
            if seen and seen["mtime"] == f.mtime and seen["size"] == f.size:
                t.skipped += 1
                continue

            rows = [EventRow(
                uid=e.uid, session_uuid=p.session_uuid, file_path=f.path, repo_key=repo_col,
                seq=float(e.seq), role=e.role, ts=e.ts or "", text=e.text,
                source=f.source, tier=f.tier, kind=kind_of(f.tier, f.source),
                worktree=ctx["worktree"], cwd=p.cwd or "",
                org=loc["org"], project=loc["project"], dir=loc["dir"],
                mem_type=p.mem_type, origin_session=p.origin_session_id,
            ) for e in p.events]

            b = pending.get(shard_key)
            if b is None:
                b = _Pending(store=store)
                pending[shard_key] = b
            if seen:
                b.deletes.append(f.path)
            b.events.extend(rows)
            b.sessions.append(SessionRow(
                session_uuid=p.session_uuid, file_path=f.path, repo_key=repo_col,
                project_dir=f.project_dir, tier=f.tier, source=f.source,
                cwd=p.cwd or "", model=p.model or "", worktree=ctx["worktree"],
                workflow_run_id=f.workflow_run_id or "", agent_id=f.agent_id or "",
                file_mtime=float(f.mtime), file_size=float(f.size),
                line_count=float(p.lines), event_count=float(len(p.events)),
                bad_lines=float(p.bad_lines),
                started_at=p.started_at or "", ended_at=p.ended_at or "",
                description=p.description or "", title=p.title or "",
                git_branch=p.git_branch or "", imported_at=_now_iso(),
            ))
            b.files.append(FileRow(file_path=f.path, repo_key=repo_col,
                                   mtime=float(f.mtime), size=float(f.size),
                                   imported_at=_now_iso()))
            man[f.path] = {"mtime": f.mtime, "size": f.size}
            t.added += len(rows)
            t.imported += 1
            since_flush += 1
            if since_flush >= FLUSH_EVERY:
                flush()
                since_flush = 0
        except Exception as err:
            t.failed += 1
            if verbose:
                print(f"  FAIL {f.path}: {str(err)[:160]}", file=sys.stderr)
        t.done += 1
        if progress and t.done % 100 == 0:
            pct = round(t.done / max(1, len(found)) * 100)
            rate = t.done / max(0.001, time.time() - t0)
            print(f"\r  {pct:3d}%  {t.done:,}/{len(found):,} files  {t.added:,} events  "
                  f"{shards.size} shards  {rate:.0f}/s   ", end="", file=sys.stderr)

    if progress and t.done >= 100:
        print("\r" + " " * 90 + "\r", end="", file=sys.stderr)
    flush()          # anything left below the batch threshold

    # THE FTS PHASE IS THE QUIET ONE, and quiet is what gets a run killed. A run killed
    # here leaves shards that still ANSWER — search falls back to a LIKE scan, slower
    # and unranked — so the index looks complete and silently ranks wrong.
    tf0 = time.time()
    stores = shards.stores()
    for i, st in enumerate(stores):
        if progress:
            print(f"\r  building full-text index  {i+1}/{len(stores)} shards   ",
                  end="", file=sys.stderr)
        try:
            st.ensure_fts_index()
            t.fts_built += 1
        except Exception as err:
            t.fts_failed += 1
            if verbose:
                print(f"\n  FTS FAIL: {str(err)[:160]}", file=sys.stderr)
    if progress and stores:
        print("\r" + " " * 60 + "\r", end="", file=sys.stderr)
    t.fts_ms = int((time.time() - tf0) * 1000)
    return t
