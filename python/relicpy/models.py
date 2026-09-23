"""
The schema, as Pydantic.

The TypeScript reference declares its Arrow schema by hand — an explicit
`new Schema([new Field("uid", new Utf8()), ...])` beside a TypeScript interface that
has to agree with it. Two declarations of one truth, kept in sync by hand.

Here the model IS the schema. `LanceModel` derives the Arrow schema from the type
hints, so a field cannot exist in the model and be missing from the table, and a
column cannot drift from the type the code reads it back into.

THE COLUMN NAMES ARE LOAD-BEARING. These models read and write the SAME LanceDB
directories as the TypeScript implementation — the same `~/.relic/banks/<bank>/...`
files, indexed by whichever ran last. So the field names here are not a style choice:
they are the wire format. Renaming `repo_key` to `repo` would silently produce a
second, incompatible column rather than an error.

AND SO ARE THE TYPES. Every count and every timestamp-as-epoch on disk is a
**float64**, not an int64 — `seq: float` is not a typo. JavaScript has one number
type, so the reference implementation declared `Float64` for `seq`, `mtime`, `size`,
`line_count`, `event_count` and `bad_lines`, and those tables already exist with
3.2 M rows in them. A Python model that types them `int` generates an int64 Arrow
schema, which does not merge into a float64 column: the write fails, or worse,
lands a second column. Verified against the live index — the mismatch was found by
diffing this model's generated schema against the table on disk, which is a check
worth keeping (see tests/test_schema_matches_disk.py).

Read them back as `int(row["seq"])` where an integer is wanted. The float is the
wire, not the domain.
"""

from __future__ import annotations

from typing import Literal, Optional

from lancedb.pydantic import LanceModel
from pydantic import BaseModel, Field

# The three tiers a transcript can be, plus the two document shapes that share the
# query surface. "note" and "memory" are not transcript tiers — a document has no
# turns — but they ride the same enum so search/show/sessions stay one code path.
Tier = Literal["session", "subagent", "workflow_agent", "note", "memory"]

DEFAULT_BANK = "default"
SHARD_DIR = ".relic"
BANKS_DIR = "banks"


# --------------------------------------------------------------------------- rows


class EventRow(LanceModel):
    """One indexed line of a transcript.

    `uid` hashes (shape, file-key, seq) — a LINE SLOT, not an event. That distinction
    is the whole reason `dedupe_hits` keys on content: a resumed session writes a new
    file under the same uuid whose slot 7 holds a different event, so one uid can name
    two different events. Measured on the real corpus: of 13 cross-root pairs, 8
    diverge at line 1, and one pair had 1,018 slots carrying a different event in each
    copy.
    """

    uid: str
    session_uuid: str
    file_path: str
    repo_key: str
    seq: float   # float64 on the wire — see module docstring
    role: str
    ts: str
    text: str
    source: str
    tier: str           # session | subagent | workflow_agent — POSITION only
    kind: str           # transcript | note | memory | message — WHAT it is
    worktree: str
    cwd: str
    org: str
    project: str
    dir: str
    mem_type: str
    origin_session: str
    # Channel facets (#85, #86) — see EventRow in src/store/lance.ts for why `via` sits
    # beside `source` rather than inside `kind`. Defaulted, like no other column here,
    # because they are "" on every row that did not arrive through a channel plugin.
    via: str = ""          # the envelope's `source`, verbatim
    chat_id: str = ""
    msg_id: str = ""
    from_user: str = ""
    from_user_id: str = ""
    sent_ts: str = ""      # the sender's clock; `ts` is the transcript's


class SessionRow(LanceModel):
    """One transcript file. A session UUID names a TREE of these, not one row."""

    session_uuid: str
    file_path: str
    repo_key: str
    project_dir: str
    tier: str
    source: str
    cwd: str
    model: str
    worktree: str
    workflow_run_id: str
    agent_id: str
    file_mtime: float   # all six are float64 on the wire — see module docstring
    file_size: float
    line_count: float
    event_count: float
    bad_lines: float
    started_at: str
    ended_at: str
    description: str
    title: str
    git_branch: str
    imported_at: str
    # Distinct values from the session's channel turns, most frequent first, comma-joined.
    via: str = ""
    chat_id: str = ""
    from_users: str = ""


class FileRow(LanceModel):
    """The manifest. (path, mtime, size) is the import diff — no content hashing.

    Written in the SAME batch as the events it describes, so an interrupt loses at
    most one batch and those files are simply re-imported. The invariant is "a file is
    only marked done once its rows are committed".
    """

    file_path: str
    repo_key: str
    mtime: float   # float64 on the wire — see module docstring
    size: float
    imported_at: str


def vector_row_model(dim: int):
    """The `vectors` row, as a model — BUILT PER DIM, because it has to be.

    `Vector(n)` bakes the width into the Arrow type (FixedSizeList<Float32, n>), so
    unlike the other three rows this schema cannot be a module-level class: 384 and
    1024 are different schemas, and the model is chosen by what the provider actually
    returned rather than by what the flag asked for.

    `dim: float` is not a typo — see the module docstring. The TypeScript reference
    writes every number as Float64, and this table already exists on disk that way.

    THE TABLE IS SEPARATE FROM `events` ON PURPOSE. A vector column cannot be added to
    an existing table by widening: `add_columns` backfills a scalar default only, so
    the column lands as Utf8 in both implementations. What happens next does NOT match,
    and the split is client-side rather than in the shared Rust core — measured on
    0.39.0, pinned by tests/test_embed.py:

        TypeScript  writes [0.1, 0.2] into that column as the string "0.1,0.2",
                    with no error at write or read.
        Python      raises ArrowNotImplementedError on the cast.

    So the silent half is TypeScript's, which is exactly where it mattered: `widen()`
    and `EventRow` live there. The rest of the case for a side table is language-
    independent — a column forces a value for every row on the next write, and
    3,394,951 events x 384 dims x 4 B is 4.86 GiB, 1.5x the whole current index.
    """
    from lancedb.pydantic import Vector

    class VectorRow(LanceModel):
        uid: str
        embedding: Vector(dim)  # type: ignore[valid-type]
        model: str
        dim: float   # float64 on the wire — see module docstring
        norm: str
        embedded_at: str

    return VectorRow


# ------------------------------------------------------------------- domain types


class Shard(BaseModel):
    """One LanceDB directory: everything from one bank for one repo."""

    key: str  # "<bank>/github.com/<org>/<repo>" — DISPLAY ONLY, no filter takes it
    dir: str
    bank: str
    repo: str  # "github.com/<org>/<repo>", or "_unresolved"


class Scope(BaseModel):
    """Which shards a query is allowed to touch.

    `bank` matches EXACTLY; `repo` is a substring of the repo portion only. They read
    two different parts of a shard key, and conflating them is the bug that shipped in
    the MCP server: it printed full shard keys under a heading saying they were what
    `repo` accepts, and `repo` matched none of them.
    """

    data_root: Optional[str] = None
    in_repo: bool = False
    repo: Optional[str] = None
    bank: Optional[str] = None


class ShardStat(BaseModel):
    key: str
    bank: str
    repo: str
    events: int
    sessions: int
    last_indexed: str = ""  # max(files.imported_at) — when the INDEXER last wrote
    newest_session: str = ""  # max(sessions.started_at) — how recent the MATERIAL is
    unindexed: int = 0  # rows the full-text index does not cover yet (#115)


class BankGroup(BaseModel):
    bank: str
    rows: list[ShardStat]
    events: int
    sessions: int
    shards: int
    last_indexed: str = ""
    newest_session: str = ""


class Hit(BaseModel):
    """A search result. The index stores a POINTER, not an archive — `file_path` plus
    `seq` is how `show` reads the real conversation back out of the source .jsonl."""

    uid: str
    session_uuid: str
    file_path: str
    repo: str
    seq: int
    role: str
    ts: str
    text: str
    source: str
    tier: str
    worktree: str
    score: float = 0.0


class PendingFile(BaseModel):
    path: str
    bank: str
    source: str
    tier: str
    state: Literal["missing", "changed"]
    mtime: int
    size: int
    session_id: str = ""  # "" for shapes that have none (vault notes, memory files)
    repo: str = "_unresolved"  # read from the transcript's own cwd, never guessed
    # Both come from the SAME parse that resolves `repo`, so they cost nothing extra
    # once a file is being listed. A report that says "missing 1" without naming it
    # makes the reader go find the file by hand — the one thing it exists to avoid.
    cwd: str = ""   # the session's own working directory, "" when it wrote none
    name: str = ""  # its title, or the slash command it opened with — see name_of


class PendingGroup(BaseModel):
    source: str
    tier: str
    found: int = 0
    indexed: int = 0
    changed: int = 0
    missing: int = 0


class PendingReport(BaseModel):
    groups: list[PendingGroup] = Field(default_factory=list)
    found: int = 0
    indexed: int = 0
    changed: int = 0
    missing: int = 0
    newest_pending_ms: Optional[int] = None
    scan_ms: int = 0
    files: list[PendingFile] = Field(default_factory=list)
    files_omitted: int = 0
    # Paths discovery could not read (#99). Files under them are in none of the counts
    # above, so "nothing pending" is only true of what the walk could see.
    unreadable: list[dict] = Field(default_factory=list)


class ParsedFile(BaseModel):
    """What a shape parser returns: one file, one session."""

    session_uuid: str
    cwd: Optional[str] = None
    model: Optional[str] = None
    started_at: Optional[str] = None
    ended_at: Optional[str] = None
    description: Optional[str] = None
    title: Optional[str] = None
    git_branch: Optional[str] = None
    lines: int = 0
    bad_lines: int = 0
    events: list["ParsedEvent"] = Field(default_factory=list)
    mem_type: str = ""
    origin_session_id: str = ""


class ParsedEvent(BaseModel):
    uid: str
    seq: int
    role: str
    ts: Optional[str] = None
    text: str
    # The cwd RECORDED ON THIS LINE, which is not always the session's first one.
    #
    # Measured on session 2bb9b553: 3,867 events in `ansible-oracle` and 201 in
    # `neo-oracle/wt/neo-arra-oracle-v4`, all filed under the first repo, so
    # `--worktree neo-arra-oracle-v4` could not reach them at all.
    #
    # FINDABLE, NOT ATTRIBUTABLE. Those 201 events stay in the shard their session
    # was filed under; they only become reachable by cwd. Sharding per event would
    # split 4 of 542 transcripts and force a union in `relic session <id>` on the
    # other 538 — a bad trade (542 transcripts, >1 cwd: 83 / 15.3%, >1 REPO: 4 / 0.7%).
    #
    # Optional because only the Claude shape records cwd per line; codex, vault, omp
    # and hermes have one cwd per file or none, and the importer falls back.
    cwd: Optional[str] = None
    # Who sent this turn, from which room, when — set only on a user turn that OPENS with a
    # channel envelope (see parse_channel_envelope). `text` keeps the envelope.
    channel: Optional[dict] = None


ParsedFile.model_rebuild()
