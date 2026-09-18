# agents-relic

Search everything you and your AI coding agents have ever said to each other.

`relic` indexes **Claude Code** and **Codex** session transcripts into LanceDB — one
shard per git repo — and gives you full-text search with the facets that actually
matter: which repo, which worktree, when, and who was speaking.

```bash
relic index --since 7d
relic search "ความจริง" --repo my-repo --prose
relic sessions --since 24h --count
```

No embeddings required. No server. One binary, one directory, nothing written into
your repos.

---

## How it works

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  relic — agent session transcripts, indexed              measured 2026-09-18 ║
║  345 shards · 3.2 M events · 37,285 sessions · 9.2 GB index over 34 GB raw   ║
╚══════════════════════════════════════════════════════════════════════════════╝

 1 ─ SOURCES                        config: ~/.relic/sources.json, no code change

     ~/.claude/projects           3.7 G    6,418 files   [on]
     ~/.claude/projects-archive   6.5 G    7,052 files   [on]
     ~/.claude/projects-1sep      13  G   25,397 files   [on]  largest, added last
     ~/.codex/sessions            11  G    1,750 files   [on]  different shape
     ~/.omx-runs                   39 M      449 files   [off] ops logs, not talk
                  │
                  │   THREE TIERS, and the third is the one that gets missed
                  │     <project>/<uuid>.jsonl                          session
                  │     <project>/<uuid>/subagents/<agent>.jsonl        subagent
                  │     <project>/<uuid>/subagents/workflows/wf_*/…     workflow_agent
                  ▼
 2 ─ PARSE                          one Parser contract, one file per shape

     claude.ts ──┐                  Claude: the whole file is transcript
     codex.ts  ──┤                  Codex:  only response_item is transcript;
                 │                          event_msg / token_usage = UI noise
                 ▼
        blockRole(content)          LABEL BY WHAT THE BLOCK IS, NOT ITS ENVELOPE
                 │                  a tool_result arrives inside a `user` message
                 │
      ┌──────────┼──────────┬───────────┬──────────┐
      ▼          ▼          ▼           ▼          ▼
  tool_result tool_use  assistant     user     thinking
    40.1%      40.1%      12.1%       6.8%       0.3%
                                        ^
                                   THE HUMAN IS 6.8% OF A TRANSCRIPT
                 │
                 ▼
 3 ─ FILTER                         --skip-noise, opt-in, every drop logged

     file-readback    810 rows  2.64 MB   3 ascending line numbers = a file dump
     edit-payload     456       0.69 MB   the file now exists on disk
     binary-blob       55       0.20 MB   base64
     navigation-call  769       0.08 MB   [tool_use Read] — intent, no content
                                          ── kept: bash, errors, all prose
     DISCARDED ──────────────────────► ~/.relic/skipped.jsonl   (the proof)
                 │
                 ▼
 4 ─ ROUTE                          identity comes from the JSONL, never a column

     cwd field ──► repoKeyOf ──► github.com/<org>/<repo>   host-independent
                    │                                       (same repo on 3 machines
                    └──► contextOf ──► worktree             = 1 shard, not 3)
                 │
                 ▼
 5 ─ STORE                          ~/.relic/github.com/<org>/<repo>/

     events · sessions · files      LanceDB. files = the manifest, written PER FILE,
                 │                  so Ctrl-C resumes instead of restarting
                 ▼
        ICU full-text index         icu 1-4 ms  ·  ngram(3) 2-36 ms and MISSES "ok"
        stem:false                  ·  raw LIKE 27-41 ms
                                    ภาษาไทยเป็นคำบรรยาย -> ภาษา|ไทย|เป็น|คำ|บรรยาย
                 │
                 ▼
 6 ─ SEARCH                         --repo ~200 ms  ·  fan-out ~1.8 s (345 shards)

     search ─┬─ --repo --worktree --path      where
             ├─ --prose --role                who was speaking
             ├─ --since --until               when
             └─ --plain --json --jsonl        for the shell
                 │
                 ├──► show <file> --seq N     reads the SOURCE .jsonl, not the index
                 │                            (the index is a pointer, not an archive)
                 └──► trace.jsonl             51 queries · 4 opened · median 151 ms
                                              340 of 345 shards: never a best hit

 LEGEND   [on]/[off] = source enabled   ! = caveat   -> = flows to
 ─────────────────────────────────────────────────────────────────────────────
 rg reads all 34 GB in ~0.7 s. This index buys FACETS, not reach or speed.
```

**What the picture shows that the prose does not.** Two numbers argue with each other:
**the human is 6.8% of a transcript**, and **340 of 345 shards have never produced a
best hit**. Five stages carefully preserve 3.2 M events, and the query log says nearly
all the value sits in five shards and one-fifteenth of the content. That is an argument
for indexing *less*, not faster.

---


## Install

```bash
bunx github:Soul-Brews-Studio/agents-relic --help      # try it
```

Or clone and link:

```bash
git clone https://github.com/Soul-Brews-Studio/agents-relic
cd agents-relic && bun install && bun link
relic --help
```

**Bun only.** The entrypoint is TypeScript, so `npx` cannot run it without a build step.
Requires `@lancedb/lancedb` (ships prebuilt binaries — no compiler needed) and a pinned
`apache-arrow@18.1.0`.

Trim ~350 MB of LanceDB's unused ML optional deps with an override in your
`package.json`:

```json
{ "overrides": { "@huggingface/transformers": "npm:sorted-object@2.0.1",
                 "openai": "npm:sorted-object@2.0.1" } }
```

---

## Quick start

```bash
relic sources                  # what agent transcripts exist on this machine
relic index --since 30d        # build the index (resumable — Ctrl-C is safe)
relic search "freelist"        # search everything
relic status                   # what you ended up with
```

Everything lands in `~/.relic/github.com/<org>/<repo>/`. Nothing is written into any
repository. Use `--in-repo` if you want each repo to carry its own shard instead.

---

## Commands

### `index` — build or update

```bash
relic index                          # all enabled sources, full history
relic index --since 7d               # only files touched in the last week
relic index --repo my-repo        # one repo — "personal memory"
relic index --corpus claude-1sep     # one configured source
relic index --skip-noise             # drop file dumps and navigation calls
relic index --dry-run                # count files, write nothing
```

Incremental by `(path, mtime, size)` — unchanged files are never re-read. The manifest
is written **per file**, so an interrupted run resumes rather than restarting. The one
cost of interrupting: full-text indexes are built at the end, so search falls back to a
slower scan until a run completes.

### `search` — full text, BM25-ranked

```bash
relic search "structured_output_mode"
relic search "ok"                          # 2 characters — works
relic search "ความจริง"                     # Thai — real word segmentation
```

| filter | what it does |
|---|---|
| `--repo my-repo` | one shard. **The speed filter** — see Performance below |
| `--worktree refactor` | worktree, agent dir, or lab the session ran in |
| `--path facebook` | any substring of the working directory |
| `--prose` | humans + assistant only — see Roles below |
| `--role user\|assistant\|tool_use\|tool_result\|thinking` | exact role |
| `--source claude-live\|codex` | which agent wrote it |
| `--tier session\|subagent\|workflow_agent` | which transcript tier |
| `--since 7d` · `--until 2026-09-17` | date range; accepts `7d` `12h` `30m` or a date |
| `--limit 40` | default 20 |

Filters stack:

```bash
relic search "vacuum" --repo my-repo --worktree refactor --since 7d --prose
```

### `sessions` — list and count

```bash
relic sessions --repo my-repo --since 24h --count     # → 64 sessions
relic sessions --repo my-repo --since 24h             # list, newest first
relic sessions --since 24h --plain | cut -f1             # just the session ids
```

Shows start time · short uuid · event count · repo · `[worktree]`, with the session's
opening user message beneath so the list is scannable.

Filters on `started_at` — the session's own first timestamp — **not** file mtime, which
moves on every append and would make an old session look new.

### `show` — read the surrounding conversation

```bash
relic show <file> --seq 224 --before 3 --after 3
```

Every search result prints its own `-> show …` line; copy it. Reads the source `.jsonl`
directly, because the index stores a **pointer**, not an archive.

### `status`, `sources`, `trace`

```bash
relic status                 # shards, events, sessions, sizes
relic sources                # configured sources and what is actually present
relic trace                  # your own query log
relic trace --cloud          # keyword cloud, log-scaled by how often you ask
```

### `skipped` — what `--skip-noise` dropped, and the proof

```bash
relic skipped                # counts by rule, with samples of what each one ate
relic skipped --json
```

Every drop is logged to `~/.relic/skipped.jsonl` with the rule that fired and the first
120 characters, because **a filter you cannot audit is a filter you cannot trust**.

### `attach` — index someone else's LanceDB

```bash
relic attach ~/.lanceglass
```

Adds an ICU full-text index and a `relic_facets` sidecar to a LanceDB owned by another
tool, without copying rows. **This writes to that database.** See Interop below.

---

## Output modes

Every command takes `--plain`, `--json`, or `--jsonl` (or `--format X`):

```bash
relic search "vacuum" --plain | cut -f1 | sort -u          # file list
relic search "ความ" --jsonl | jq -r '"\(.repo) seq=\(.seq)"'
relic search "freelist" --json | jq '{total, ms}'
relic status --json | jq '.rows[:5]'
```

`plain` is `file⇥seq⇥repo⇥text`. `jsonl` is one object per line — pipes into `jq`
without slurping. Progress and errors go to stderr, so stdout carries only data.

Search-and-read in one chain:

```bash
relic search "$1" --plain --limit 1 | cut -f1,2 | \
  xargs -n2 sh -c 'relic show "$0" --seq "$1" --before 5 --after 5'
```

---

## Roles — the thing that makes search useful

**80% of a session transcript is tool traffic, not conversation.** Claude delivers a
tool result as a `user` message wrapping a `tool_result` block, so a naive parser files
command output as something the human said.

Measured on one shard, before and after labelling by block type rather than envelope:

```
before   assistant 52.0%   user 47.5%   system 0.5%
after    tool_use 40.1%   tool_result 40.1%   assistant 12.1%   user 6.8%   thinking 0.3%
```

The human is **6.8%** of a transcript. Without role labelling, every search ranks
command output above the reasoning you were looking for:

```bash
relic search "freelist"              # → [tool_result] === fan-out ===  (noise)
relic search "freelist" --prose      # → "95% of the file is freelist. Checking what churned it."
```

Use `--prose` by default when you are looking for thinking rather than output.

---

## What `--skip-noise` drops, and what it deliberately does not

Measured on a 285-file shard — **14% of stored text**:

| rule | rows | MB | what it is |
|---|---|---|---|
| `file-readback` | 810 | 2.64 | a file read into the transcript |
| `edit-payload` | 456 | 0.69 | an Edit/Write payload — the file now exists on disk |
| `binary-blob` | 55 | 0.20 | base64 images and similar |
| `navigation-call` | 769 | 0.08 | `[tool_use Read] {"file_path":…}` — intent, no content |

**Kept on purpose**: bash commands (*"what was that command again"* is a real query),
error text in `tool_result`, and all prose.

### Three rules this filter got wrong first

The numbers above are the third attempt. The proof log caught each failure:

1. **A rule that matched nothing.** The cap check compared against `MAX_TEXT` (16,000)
   while `tool_result` is truncated at 4,000 — it silently dropped zero rows while
   reporting success.
2. **A rule that ate real content.** `/token.?usage/i` matched the word "token" inside
   a tool_result containing a *tokenizer's* source. A noise rule matching a common word
   will eat the thing you were searching for.
3. **The wrong signal entirely.** Dropping every `tool_result` at the cap would have
   reclaimed 34% — and also deleted a session-dig result and a metrics table, long
   output existing nowhere else. **Length is not a proxy for worthlessness.** The real
   signature is three consecutive ascending line numbers, which a file dump has and
   prose, tables and command output do not.

The first analysis predicted 42.7%. The honest number is 14%, because "big" is not
"worthless".

## Configuring sources

`relic sources` shows what is registered. Add a root without touching code via
`~/.relic/sources.json`:

```json
{
  "disable": ["claude-archive"],
  "add": [
    {
      "key": "claude-1sep",
      "path": "/Users/you/.claude/projects-1sep-tue2026",
      "walk": "claude-tiers",
      "shape": "claude",
      "note": "older snapshot root"
    }
  ]
}
```

`walk` is `claude-tiers` (the three-tier Claude layout) or `flat` (recursive file walk).
`shape` is `claude` or `codex`.

Built-in: `claude-live`, `claude-archive`, `codex`, and `omx-logs` (**off** by default —
those `.jsonl` files are ops logs, not conversation, and indexing them floods search
with noise).

---

## Design notes

### Three tiers, and the third is the one that gets missed

```
<root>/<project>/<uuid>.jsonl                                   session
<root>/<project>/<uuid>/subagents/<agent>.jsonl                 subagent
<root>/<project>/<uuid>/subagents/workflows/wf_<run>/agent-*    workflow_agent
```

That third path sits one directory deeper than an obvious glob reaches — and it is
usually the **largest tier by file count**. Any tool using a two-level glob is silently
reading a partial corpus.

### Repo identity is host-independent

The same repo lives at a different absolute path on every machine, and sessions carry
whichever one they ran under:

```
/opt/Code/github.com/acme/my-repo          machine A
/home/dev/Code/github.com/acme/my-repo     machine B
/home/ci/ghq/github.com/acme/my-repo       another account
```

`repoKeyOf` finds `github.com/<org>/<repo>` **anywhere** in the path, so one repo gets
one shard instead of four. Sibling worktrees (`my-repo.wt-5-slug`) collapse into their
repo for storage while keeping the worktree as a **searchable field** — because a
worktree name is usually a statement of intent.

Identity always comes from the transcript's own `cwd` field. Neither the encoded project
directory (it maps both `/` and `.` to `-`, lossy and not reversible) nor a derived
database column can reconstruct a repo key.

### Event identity excludes the path

`sha1(source, basename, seq)` — the directory is deliberately not part of the id, so the
same transcript discovered under two roots dedups instead of doubling.

### `seq` is the Nth non-empty line

Both parsers count non-empty lines only, so the index and the file always agree and
`show` can jump straight to a line.

### Codex is a different shape, not a rename

A Claude transcript *is* the file. A Codex rollout is a stream of **mixed record types**
where only `response_item` carries transcript — `event_msg` and `token_usage_record` are
UI bookkeeping, counted but never indexed. Codex also emits `reasoning` as its own role,
which Claude has no equivalent for, so the two corpora are not symmetric.

---

## Why LanceDB only

Earlier designs paired LanceDB with SQLite FTS5 on a stale benchmark claiming LanceDB's
full-text search was "10–200× slower". Re-measured on a real 91,484-event shard:

```
query                     ngram(3)      icu        LIKE scan
freelist                   36 ms       4 ms         41 ms
ความ                        2 ms       2 ms         30 ms
structured_output_mode     35 ms       1 ms         28 ms
ok                       0 HITS        1 ms         27 ms
```

The **ICU tokenizer** wins outright, builds in 1.4 s for 91k rows, and does real Thai
word segmentation — verified with `table.tokenize()`:

```
ภาษาไทยเป็นคำบรรยาย  →  ภาษา | ไทย | เป็น | คำ | บรรยาย
```

One store, one index, no query routing, no second thing to drift. `stem: false` is set
deliberately — the English stemmer mangles identifiers (`structured_output_mode` →
`structured_output_mod`).

---

## Performance

Measured at 345 shards / 3.2 M events:

| query | latency |
|---|---|
| `--repo <one>` | **~200 ms** |
| fan-out (all shards) | **~1.8 s** |

Latency scales with **shard count**, not corpus size. Use `--repo` when you know where
you are looking.

An honest caveat: `rg` searches 14.7 GB of raw JSONL in ~0.7 s. relic earns its place
through **facets and structure** — repo, worktree, role, date, session listing — not
through reach or raw speed.

---

## Interop

`relic attach <dir>` adds an ICU index and a facets sidecar to a LanceDB owned by
another tool (built for [lanceglass](https://github.com/Soul-Brews-Studio/lanceglass),
whose event model is block-level and content-addressed).

**This writes to that database.** So does lanceglass itself — its `table()` calls
`create()` on every read, so merely inspecting a foreign LanceDB writes tables into it.
Point neither tool at a directory you do not own.

---

## Trace log

Every query appends one JSONL line to `~/.relic/trace.jsonl`: timestamp, query, filters,
shards searched, hits, latency, and which repo produced the top hit. `relic show`
records an `opened` entry, because a result *returned* is not a result *used*.

```bash
relic trace              # who answers · which filters matter · what is dead
relic trace --cloud      # keyword cloud
relic trace --jsonl | jq -r '"\(.n)\t\(.term)"'
```

It records query **shape** only, never matched text, so the log cannot become a second
copy of the corpus. Opt out with `RELIC_NO_TRACE=1`.

The useful line is `N shard(s) never produced a best hit` — which turns "is this index
worth keeping" into a count instead of an argument.

---

## Not in scope

- **Vault markdown.** relic indexes session transcripts. Indexing notes is a different
  tool's job.
- **Federating over other indexes.** Querying N heterogeneous stores means N adapters,
  incomparable relevance scores, and no shared dedup key. Where content is genuinely
  unique, ingest it as a source instead.
- **Embeddings.** The schema leaves room (vectors land in the same table, no migration),
  but on this corpus keyword retrieval measured far ahead of vectors, so keyword ships
  first.

## License

MIT
