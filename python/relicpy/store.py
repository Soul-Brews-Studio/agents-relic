"""One shard, as an object.

The ORM-ish half of the port: a `LanceStore` wraps one LanceDB directory and hands
back Pydantic models, so callers never touch Arrow or raw dicts. Writes go through
`merge_insert` on the model's primary key, which makes every write idempotent — a
re-import of the same file replaces its rows instead of doubling them.
"""

from __future__ import annotations

import os
from typing import Iterable, Optional

import lancedb

from .models import EventRow, FileRow, SessionRow


class LanceStore:
    """A shard. Opened lazily; tables are created on first write, never on read.

    Creating tables on READ is the trap this avoids: `status` and `search` open every
    shard, and a read that materialises an empty `events` table turns "nothing indexed
    here" into "indexed, zero rows" — which then looks healthy in a status report.
    """

    def __init__(self, dirname: str):
        self.dir = dirname
        self.db = lancedb.connect(dirname)

    @classmethod
    def open(cls, dirname: str) -> "LanceStore":
        return cls(dirname)

    # ----------------------------------------------------------------- read side

    def _existing(self, name: str):
        """The table, or None. Never creates.

        `list_tables()` returns a ListTablesResponse, NOT a list of strings — so
        `name not in self.db.list_tables()` is False for every table that exists, and
        every shard silently reports zero rows. That is the shape of the bug: swapping
        the deprecated `table_names()` for its replacement raised no error, changed no
        types visibly, and turned a 3.2 M-event index into an empty one. Caught only
        by the parity test against the reference implementation.

        `table_names()` has its own trap — it defaults to `limit=10`, so it is not a
        safe general listing either. Three tables is under both, but read `.tables`
        explicitly rather than relying on that.
        """
        try:
            if name not in self.db.list_tables().tables:
                return None
            return self.db.open_table(name)
        except Exception:
            return None

    def counts(self) -> dict[str, int]:
        def n(name: str) -> int:
            t = self._existing(name)
            return t.count_rows() if t is not None else 0
        return {"events": n("events"), "sessions": n("sessions"), "files": n("files")}

    def freshness(self) -> dict[str, str]:
        """Two different "when", and conflating them is the trap.

        `last_indexed` is max(files.imported_at) — when the INDEXER last wrote here.
        `newest_session` is max(sessions.started_at) — when the newest transcript
        BEGAN. Reindexing an old corpus moves the first and leaves the second months
        back; an index that has not run since Tuesday still shows a recent second.
        Only the first answers "is this current".
        """
        def mx(table: str, col: str) -> str:
            t = self._existing(table)
            if t is None:
                return ""
            try:
                vals = t.to_arrow().column(col).to_pylist()
            except (KeyError, OSError, ValueError):
                # A column that is absent or a shard that is unreadable is "no answer",
                # not a crash. A bare `except` here would also swallow the ImportError
                # that says a dependency is missing, which is how a hard failure
                # becomes a silently empty column.
                return ""
            best = ""
            for v in vals:
                v = str(v or "")
                if v > best:
                    best = v
            return best
        return {"last_indexed": mx("files", "imported_at"),
                "newest_session": mx("sessions", "started_at")}

    def manifest(self) -> dict[str, dict[str, float]]:
        """(path -> mtime,size) — the same identity the importer skips on."""
        t = self._existing("files")
        if t is None:
            return {}
        tbl = t.to_arrow().select(["file_path", "mtime", "size"])
        return {r["file_path"]: {"mtime": r["mtime"], "size": r["size"]}
                for r in tbl.to_pylist()}

    def sessions(self, limit: Optional[int] = None) -> list[SessionRow]:
        t = self._existing("sessions")
        if t is None:
            return []
        rows = t.to_arrow().to_pylist()
        if limit:
            rows = rows[:limit]
        return [SessionRow(**r) for r in rows]

    def search(self, query: str, limit: int = 20, where: Optional[str] = None) -> list[dict]:
        """BM25 over the ICU full-text index, with a LIKE fallback.

        The fallback is not a nicety: a shard whose FTS index failed to build still
        ANSWERS, just 7-28x slower and with no `_score`. Silently returning zero hits
        there would make a broken index look like an empty one.
        """
        t = self._existing("events")
        if t is None:
            return []
        try:
            q = t.search(query, query_type="fts").limit(limit)
            if where:
                q = q.where(where)
            return q.to_list()
        except Exception:
            safe = query.replace("'", "''")
            clause = f"text LIKE '%{safe}%'"
            if where:
                clause = f"({clause}) AND ({where})"
            return t.search().where(clause).limit(limit).to_list()

    # ---------------------------------------------------------------- write side

    def put_events(self, rows: Iterable[EventRow]) -> None:
        self._merge("events", EventRow, "uid", rows)

    def put_sessions(self, rows: Iterable[SessionRow]) -> None:
        self._merge("sessions", SessionRow, "file_path", rows)

    def put_files(self, rows: Iterable[FileRow]) -> None:
        self._merge("files", FileRow, "file_path", rows)

    def _merge(self, name: str, model, key: str, rows: Iterable) -> None:
        data = [r.model_dump() for r in rows]
        if not data:
            return
        # mergeInsert REJECTS THE WHOLE BATCH if two source rows share a key
        # ("Ambiguous merge inserts are prohibited") — not the offending row, the
        # batch. Per-file writes could never hit it; batched ones can, for any shape
        # whose key scheme is not unique within a batch. One bad pair must not discard
        # 250 files of work, so dedupe here, keeping the LAST occurrence.
        seen: dict[str, dict] = {}
        for d in data:
            seen[d[key]] = d
        data = list(seen.values())
        t = self._existing(name)
        if t is None:
            self.db.create_table(name, data=data, schema=model.to_arrow_schema())
            return
        t.merge_insert(key).when_matched_update_all().when_not_matched_insert_all().execute(data)

    def delete_events_of(self, file_path: str) -> None:
        """Drop a file's rows before its new generation lands, or the two coexist."""
        t = self._existing("events")
        if t is None:
            return
        safe = file_path.replace("'", "''")
        t.delete(f"file_path = '{safe}'")

    def ensure_fts_index(self) -> None:
        t = self._existing("events")
        if t is None:
            return
        for idx in t.list_indices():
            if idx.index_type == "FTS":
                return
        # ICU, not ngram: real Thai word segmentation, and 2-character queries work.
        # stem off — "indexing" must not collapse into "index".
        t.create_fts_index("text", use_tantivy=False, base_tokenizer="simple",
                           language="English", stem=False, remove_stop_words=False)
