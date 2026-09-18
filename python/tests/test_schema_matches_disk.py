"""The Python models and the TypeScript tables describe ONE set of files.

This is the test that earns the port its right to write. It is skipped, not failed,
when there is no index on this machine — a fresh checkout has nothing to compare
against, and a red suite there would say something untrue.
"""

import os
import pytest

lancedb = pytest.importorskip("lancedb")

from relicpy.models import EventRow, FileRow, SessionRow

SHARD = os.path.expanduser("~/.relic/banks/projects/github.com/laris-co/neo-oracle")


@pytest.mark.parametrize("table,model", [
    ("events", EventRow), ("sessions", SessionRow), ("files", FileRow),
])
def test_model_schema_matches_the_table_on_disk(table, model):
    if not os.path.isdir(SHARD):
        pytest.skip(f"no indexed shard at {SHARD}")
    disk = {f.name: str(f.type) for f in lancedb.connect(SHARD).open_table(table).schema}
    mine = {f.name: str(f.type) for f in model.to_arrow_schema()}
    # Names AND types. A name-only check passes while `seq: int` writes an int64
    # column into a float64 table, which is the exact bug this file exists for.
    assert mine == disk
