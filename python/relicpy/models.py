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


ParsedFile.model_rebuild()
