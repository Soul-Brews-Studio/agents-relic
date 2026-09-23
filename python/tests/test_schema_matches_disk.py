"""The Python models and the TypeScript tables describe ONE set of files.

This is the test that earns the port its right to write. It is skipped, not failed,
when there is no index on this machine — a fresh checkout has nothing to compare
against, and a red suite there would say something untrue.

THE RULE IS NOT EQUALITY, AND THAT IS DELIBERATE.

The model may be AHEAD of disk: `widen()` adds a column on WRITE, so a newly-added
field (`kind`) is absent from every shard until that shard is rewritten. Demanding
equality would turn a working lazy migration into a red suite.

The model must never be BEHIND disk. A column that exists on disk and not in the model
is data the model cannot see — and since writes go through the model, a rewrite would
silently drop it.

Types must match on every SHARED column. That is the check that caught the real bug:
every integer column here is float64, not int64, because JavaScript has one number
type. A names-only comparison passes while `seq: int` writes the wrong column type.
"""

import os

import pytest

lancedb = pytest.importorskip("lancedb")

from relicpy.models import EventRow, FileRow, SessionRow

SHARD = os.path.expanduser("~/.relic/banks/projects/github.com/laris-co/neo-oracle")

# Fields the model has that older shards legitimately lack, each with the reason.
# Listing them explicitly is the point: a typo'd or accidental new field fails here
# instead of being waved through as "probably a migration".
PENDING_MIGRATION = {
    "events": {"kind",       # issue #12 — split out of `tier`, backfilled by widen()
               # #85/#86 channel facets — "" until widen(); filled by index --backfill-channel
               "via", "chat_id", "msg_id", "from_user", "from_user_id", "sent_ts"},
    "sessions": {"via", "chat_id", "from_users"},   # #85/#86 — a session's rooms and senders
    "files": set(),
}


@pytest.mark.parametrize("table,model", [
    ("events", EventRow), ("sessions", SessionRow), ("files", FileRow),
])
def test_model_is_never_behind_the_table_on_disk(table, model):
    if not os.path.isdir(SHARD):
        pytest.skip(f"no indexed shard at {SHARD}")
    disk = {f.name: str(f.type) for f in lancedb.connect(SHARD).open_table(table).schema}
    mine = {f.name: str(f.type) for f in model.to_arrow_schema()}

    missing = set(disk) - set(mine)
    assert not missing, f"on disk but not in the model (a rewrite would drop these): {missing}"

    ahead = set(mine) - set(disk)
    assert ahead <= PENDING_MIGRATION[table], \
        f"model has columns disk lacks, and they are not declared migrations: {ahead - PENDING_MIGRATION[table]}"


@pytest.mark.parametrize("table,model", [
    ("events", EventRow), ("sessions", SessionRow), ("files", FileRow),
])
def test_shared_columns_have_identical_types(table, model):
    if not os.path.isdir(SHARD):
        pytest.skip(f"no indexed shard at {SHARD}")
    disk = {f.name: str(f.type) for f in lancedb.connect(SHARD).open_table(table).schema}
    mine = {f.name: str(f.type) for f in model.to_arrow_schema()}
    mismatched = {k: (disk[k], mine[k]) for k in set(disk) & set(mine) if disk[k] != mine[k]}
    # (column, disk_type, model_type) — int64 here means someone typed a count as `int`
    assert not mismatched, f"type mismatch (disk, model): {mismatched}"
