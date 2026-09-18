# relicpy — relic, in Python

The same app as the TypeScript `relic`, over the **same index**. Not a reimplementation
that happens to look similar: `relic-py status` opens the identical
`~/.relic/banks/<bank>/github.com/<org>/<repo>/` directories the TypeScript CLI writes,
and a test asserts the two agree shard-for-shard.

```bash
cd python
uv sync
uv run relic-py status
uv run relic-py search "peak concurrency" --bank projects-archive
uv run relic-py banks
```

## The Pydantic part

The TypeScript reference declares its Arrow schema by hand, beside a TypeScript
interface that has to agree with it — two declarations of one truth, kept in sync
manually. Here the model **is** the schema:

```python
class EventRow(LanceModel):
    uid: str
    session_uuid: str
    seq: float          # float64 on the wire — not a typo, see below
    role: str
    text: str
    ...
```

`LanceModel` derives the Arrow schema from the type hints, so a field cannot exist in
the model and be missing from the table. `LanceStore` returns these models rather than
dicts, and every write goes through `merge_insert` on the model's key, so a re-import
replaces rows instead of doubling them.

## What the port found

**Every integer column on disk is `float64`, not `int64`.** JavaScript has one number
type, so the reference declared `Float64` for `seq`, `mtime`, `size`, `line_count`,
`event_count` and `bad_lines` — and those tables already hold 3.2 M rows. A Python model
typing them `int` generates an int64 schema that does not merge into a float64 column.

The mismatch was found by diffing the generated schema against the live table, which is
now `tests/test_schema_matches_disk.py`. It compares **names and types**: a name-only
check passes while `seq: int` writes the wrong column type.

## Verified

Against the live index — 6 banks, 508 shards:

| | TypeScript | Python |
|---|---|---|
| shards | 508 | **508** |
| events | 3,258,529 | **3,258,529** |
| sessions | 40,865 | **40,865** |
| `status` | 1.42 s | **0.94 s** |
| `search "peak concurrency"` | 470 matches, 295 ms | 470 matches, 676 ms |
| `search --bank projects-archive` | 132 matches, 87 ms | 132 matches, 190 ms |

Search is ~2x slower here; `status` is faster. Both fan out over shards in a thread
pool, and Python pays for the GIL on the many-small-queries path while winning on the
one where the work is mostly waiting on Arrow.

`tests/test_parity_with_typescript.py` runs the reference CLI and asserts the same shard
count, the same event and session totals, the **same shard keys**, and the same
per-shard counts. Two implementations can agree on 508 while disagreeing about *which*
508, if one walks a directory level the other misses — so the keys are compared, not
just the count.

## Scope

**Reader, deliberately.** Indexing is where two implementations could corrupt each
other's tables. The write path exists in `store.py` (`put_events`, `put_sessions`,
`put_files`, `ensure_fts_index`) and is exercised only by tests; until it has taken the
hammering the TypeScript writer has, the honest scope is: read the index anyone can
write, and prove the numbers agree.

Implemented: models, shard layout, store, search, status, banks, and the pure helpers
(`dedupe_hits`, `group_by_bank`, `max_iso`, `session_id_of_path`).

Not ported yet: `index`, `sessions`, `session`, `chain`, `show`, `dig`, `now`,
`pending`, `memory`, `trace`, and the MCP server.

```bash
uv run pytest tests/ -q      # 31 passed
```
