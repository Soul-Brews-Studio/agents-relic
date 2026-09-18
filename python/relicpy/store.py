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

from .models import EventRow, FileRow, SessionRow, vector_row_model


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

    def session_rows(self) -> list[dict]:
        """Raw session dicts, for callers that join across shards.

        Returned as dicts rather than SessionRow because the caller decorates them with
        `repo` and `bank` — fields that belong to the SHARD, not the row, and that a
        strict model would reject.
        """
        t = self._existing("sessions")
        if t is None:
            return []
        return t.to_arrow().to_pylist()

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

    def main_tiers_filter(self) -> str:
        """The "main" predicate: the human's own thread, plus documents.

        ONE definition, used by search AND by embed. If they drift, a backfill embeds a
        different population than the one search reads back, and the symptom is recall
        — not an error.

        THE COLUMN IS ABSENT ON OLD SHARDS, NOT EMPTY. `kind` arrived by widening, which
        adds a column on WRITE, so shards that predate it have no such field. A filter
        that NAMES the column is invalid SQL there, every shard throws, the per-shard
        catch swallows it, and the search returns zero hits while reporting a healthy
        shard count. So the schema picks the filter before any SQL is built.
        """
        t = self._existing("events")
        if t is None:
            return "(tier = 'session' OR tier = 'note')"
        try:
            names = set(t.schema.names)
        except Exception:
            names = set()
        if "kind" not in names:
            return "(tier = 'session' OR tier = 'note')"
        return ("((kind = 'transcript' AND tier = 'session')"
                # note and message are whole-kind includes: a vault note has no tier
                # worth filtering on, and a hermes message is a human conversation.
                " OR kind = 'note' OR kind = 'message'"
                # rows written by an older build into a shard that HAS the column
                " OR (kind = '' AND (tier = 'session' OR tier = 'note')))")

    # -------------------------------------------------------------- vectors (read)

    def vector_stats(self) -> Optional[dict]:
        """What is embedded here, and with what. None when never embedded — the normal
        state, since `index` never writes vectors.

        Read off row 0 rather than trusted from a flag: the table outlives whatever the
        caller thinks it asked for.
        """
        t = self._existing("vectors")
        if t is None:
            return None
        n = t.count_rows()
        if not n:
            return {"rows": 0, "model": "", "dim": 0, "norm": ""}
        r = t.search().limit(1).to_list()[0]
        return {"rows": n, "model": str(r.get("model") or ""),
                "dim": int(r.get("dim") or 0), "norm": str(r.get("norm") or "")}

    def embedded_uids(self) -> set[str]:
        """Every uid that already has a vector — the anti-join key for a resumable run."""
        t = self._existing("vectors")
        if t is None:
            return set()
        return {str(u) for u in t.to_arrow().column("uid").to_pylist()}

    def unembedded(self, limit: Optional[int] = None, main_tiers: bool = True,
                   min_chars: int = 24) -> list[dict]:
        """Events with no vector yet.

        LanceDB has no join, so the anti-join is in memory — affordable BECAUSE this is
        per shard: the largest shard in the live index holds well under a million uids,
        not the 3.4 M of the whole corpus.

        `min_chars` is not tidiness. A two-character event embeds to a vector close to
        everything, so it pollutes every result list while carrying no meaning, and it
        costs the same to compute as a real one.
        """
        t = self._existing("events")
        if t is None:
            return []
        done = self.embedded_uids()
        q = t.search().select(["uid", "text"])
        if main_tiers:
            q = q.where(self.main_tiers_filter())
        out: list[dict] = []
        for r in q.limit(0).to_list():
            uid = str(r.get("uid") or "")
            if uid in done:
                continue
            text = str(r.get("text") or "")
            if len(text) < min_chars:
                continue
            out.append({"uid": uid, "text": text})
            if limit and len(out) >= limit:
                break
        return out

    def embeddable_count(self, main_tiers: bool = True, min_chars: int = 24) -> int:
        """The denominator: eligible events, ignoring what is already done."""
        t = self._existing("events")
        if t is None:
            return 0
        q = t.search().select(["text"])
        if main_tiers:
            q = q.where(self.main_tiers_filter())
        return sum(1 for r in q.limit(0).to_list()
                   if len(str(r.get("text") or "")) >= min_chars)

    # ---------------------------------------------------------------- write side

    def put_events(self, rows: Iterable[EventRow]) -> None:
        self._merge("events", EventRow, "uid", rows)

    def put_sessions(self, rows: Iterable[SessionRow]) -> None:
        self._merge("sessions", SessionRow, "file_path", rows)

    def put_files(self, rows: Iterable[FileRow]) -> None:
        self._merge("files", FileRow, "file_path", rows)

    def put_vectors(self, rows: list[dict], dim: int) -> None:
        """Upsert embeddings. `dim` chooses the schema, so it comes from the provider's
        actual output, never from a flag — see vector_row_model()."""
        if not rows:
            return
        model = vector_row_model(dim)
        data = {r["uid"]: r for r in rows}      # same last-wins dedupe as _merge
        t = self._existing("vectors")
        if t is None:
            self.db.create_table("vectors", data=list(data.values()),
                                 schema=model.to_arrow_schema())
            return
        (t.merge_insert("uid").when_matched_update_all()
          .when_not_matched_insert_all().execute(list(data.values())))

    def drop_vectors(self) -> bool:
        """Drop `vectors`. The ONLY way to change model or dim on a shard: a
        FixedSizeList has one width, so there is no in-place widening.

        Scoped to `vectors`, so the worst case is re-running a backfill — never an
        index.
        """
        if "vectors" not in self.db.list_tables().tables:
            return False
        self.db.drop_table("vectors")
        return True

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
        # EVERY ONE OF THESE MATCHES src/store/lance.ts, and each has a reason.
        #
        # base_tokenizer="icu" — real Thai word segmentation. Thai has no spaces, and
        # `simple` splits on whitespace, so a whole Thai sentence becomes ONE token and
        # nothing inside it is findable. I shipped `simple` here first: measured on one
        # Thai sentence, the index could find 1 of 12 substrings against ICU's 11.
        # ngram(3) is the other option and it MISSES 2-character queries entirely.
        #
        # stem=False — this is a CODE corpus and the English stemmer mangles
        # identifiers: structured_output_mode -> structured_output_mod. The cost is
        # that `sessions` no longer matches `session`, which is the right trade when a
        # 3,000-event sample holds 354 distinct identifiers over 21 characters.
        #
        # max_token_length=128 — long identifiers and 64-char hashes survive whole.
        t.create_fts_index("text", use_tantivy=False, base_tokenizer="icu",
                           stem=False, remove_stop_words=False, max_token_length=128)
