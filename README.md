# relic

Per-repo LanceDB index of every Claude Code **and** Codex session transcript.
One store. No embeddings yet — they land in the same table, no migration.

```bash
bun src/cli.ts index --since 7d                    # incremental
bun src/cli.ts search "ภาษาไทย" --worktree turso    # BM25, ICU tokenizer
bun src/cli.ts show <file> --seq 34                # context from the FILE
bun src/cli.ts sources                             # what this machine has
bun src/cli.ts status
```

Data is sharded per repo, ghq-style, so an oracle's history travels with its checkout:

```
/opt/Code/github.com/<org>/<repo>/.relic/      LanceDB dir
/opt/Code/_relic-unresolved/                   sessions with no resolvable cwd
```

Each shard self-ignores (`.gitignore` containing `*`), so no repo's own ignore file is
touched. `--data-root PATH` mirrors the same shape outside the repos instead.

## Why LanceDB only

An earlier internal lab paired LanceDB with SQLite FTS5, on a measurement that
LanceDB's own full-text search was "10-200x slower than FTS5". **That note is stale** —
it predates the current engine. Re-measured on a real 91,484-event shard:

```
query                     ngram(3)      icu        LIKE scan
freelist                   36 ms       4 ms         41 ms
ความ                        2 ms       2 ms         30 ms
structured_output_mode     35 ms       1 ms         28 ms
ok                       0 HITS        1 ms         27 ms
```

ICU wins outright, and the FTS index builds in 1.4 s for 91k rows. So one store, one
index, and the whole second-engine apparatus disappears:

- **no second index to drift** — nothing to reconcile, nothing to rebuild
- **no query routing** — FTS5 needed *two* tables (trigram + unicode61) and a rule to
  pick between them, because trigram structurally cannot match a needle under 3 chars.
  ICU answers `ok` in 1 ms.
- **real Thai segmentation, not trigrams** — verified with `table.tokenize()`:
  `ภาษาไทยเป็นคำบรรยาย` → `ภาษา | ไทย | เป็น | คำ | บรรยาย`. FTS5's unicode61 found 5 of
  435 hits for `ความ` because Thai does not use whitespace.
- **BM25 ranking**, which a `LIKE` scan cannot give at all
- vectors land in the same table later, no migration

Two corrections worth recording, both found by measuring rather than reasoning:

1. Lance `LIKE` appeared to return *fewer* hits than FTS5 (20 vs 25). Not a matching
   deficiency — that lab capped stored text at 4,000 chars. Uncapped, the gap closes.
2. `structured_output_mode` was being indexed as `structured_output_mod`. The cause was
   **stemming**, not token truncation — the English stemmer mangles identifiers, so
   `stem: false` is set deliberately. See `ensureFtsIndex`.

## The algorithm

### Three tiers, and the third is the one that gets missed

```
<root>/<project>/<uuid>.jsonl                                   session
<root>/<project>/<uuid>/subagents/<agent>.jsonl                 subagent
<root>/<project>/<uuid>/subagents/workflows/wf_<run>/agent-*    workflow_agent
```

That third path sits one directory deeper than an obvious glob reaches — the bug in
`/dig --deep`, which silently drops the largest tier by file count. Measured here:
**4,910 session · 3,372 subagent · 5,173 workflow_agent · 1,750 codex**.

### Worktree is context, not noise

Sibling worktrees (`my-repo.wt-5-<slug>`) once produced **17 shards for one repo**.
They now collapse into the owning repo for storage — but the worktree is kept as a
searchable field, because a worktree name is usually a statement of intent:

```
1059  (main)
 112  big-refactor-2026-09
  62  remote-control-2026-09
  47  api-v4-2026-09
```

`search --worktree refactor` goes straight to that worktree's work. `agents/<name>` and
`ψ/lab/<name>` are captured the same way.

### Sources are configurable, and honest about what they are

`sources` lists what this machine has. Only Claude and Codex write JSONL conversation;
everything else is opt-in and labelled:

- `omx-logs` — jsonl, but **ops logs not conversation**. Off by default.
- `omp` (405 MB) and `hermes` — real history, but **SQLite**. Listed as needing a
  different reader rather than silently omitted.

Add a source without touching code via `~/.relic/sources.json` (`disable`/`enable`/`add`).

### Repo key is host-independent

The same repo lives at a different absolute path on every machine, and sessions carry
whichever one they ran under (`/opt/Code/...`, `/home/ci/ghq/...`, `/home/dev/Code/...`).
`repoKeyOf` finds `github.com/<org>/<repo>` *anywhere* in the path, so one repo gets
one shard instead of four. Worktrees and subdirectories collapse into the owning repo.

### Event uid excludes the path

`sha1(source, basename, seq)` — the directory is deliberately not part of identity, so
the same transcript found under two roots dedups instead of doubling.

### Import identity is (path, mtime, size)

No content hashing. Verified: a re-run skipped 56 of 57 files and re-imported only the
one still being appended to.

### seq = Nth non-empty line, and context comes from the file

The index is a **pointer**, not an archive. `show` re-reads the source `.jsonl` — 27 ms
— and both parsers count non-empty lines only, so index and file agree.

### Codex is a different shape, not a rename

A Claude transcript *is* the file. A Codex rollout is a stream of mixed record types
where only `response_item` carries transcript; `event_msg` and `token_usage_record` are
UI bookkeeping, counted but never indexed. Identity falls back
`session_meta.id → session_id → filename`, because a rollout truncated before its
metadata line still needs a stable id. Codex also emits `reasoning` as its own role,
which Claude has no equivalent for — the two corpora are not symmetric.

### Pinned LanceDB lessons

Each of these cost a real debugging session:

- pin `apache-arrow@18.1.0`
- **plain JS objects only** into `createTable`/`mergeInsert` — class instances mangle
- assert `countRows()` after create — a table can be created and hold nothing
- no nulls in typed columns; use `""` / `0` so the schema infers cleanly
- `mergeInsert(key).whenMatchedUpdateAll().whenNotMatchedInsertAll()` makes re-import
  idempotent; delete a file's events first so a *shrinking* file leaves no orphans

### `--corpus`, never `--root`

A parameter named `root` tends to collide with a global flag and silently broaden scope
instead of erroring. Name the scoping flag something else.

## Status

Working end to end: discovery across all four source/tier combinations, per-repo
sharding, incremental skip, Thai and 2-character search, `show` alignment, Codex
ingest. Not yet: vectors, a `--json` mode, and a tail/follow mode.
