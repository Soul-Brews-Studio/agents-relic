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
║  6 banks · 508 shards · 3,258,529 events · 40,865 sessions · 2.7 GB index    ║
╚══════════════════════════════════════════════════════════════════════════════╝

 1 ─ SOURCES                        config: ~/.relic/sources.json, no code change

     ONE SOURCE = ONE BANK.       a bank is the top level of the shard path

     source              raw     bank                     index
     ~/.claude/projects  3.7 G   projects                  357 M   [on]
     …/projects-archive  6.5 G   projects-archive          737 M   [on]
     …/projects-1sep     13  G   projects-1sep-tue2026     1.5 G   [on]  largest
     ~/.codex/sessions   11  G   codex                     141 M   [on]  other shape
     ~/.omp/…/sessions    32 M   omp                       9.6 M   [on]
     ~/.claude/…/memory   —       memory                    2.9 M   [on]  typed facts
     ~/.relic-vault-unset  ?     vault                     —       [off] path unset
     ~/.hermes             ?     hermes                    —       [off] SQLite
     ~/.omx-runs          39 M   omx-logs                  —       [off] ops logs
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
 5 ─ STORE                          ~/.relic/banks/<bank>/github.com/<org>/<repo>/
                                    BANK FIRST. Three Claude roots are overlapping
                                    snapshots of one machine, so the same session
                                    exists in two banks — as two physical rows.

     events · sessions · files      LanceDB. files = the manifest, written PER FILE,
                 │                  so Ctrl-C resumes instead of restarting
                 ▼
        ICU full-text index         icu 1-4 ms  ·  ngram(3) 2-36 ms and MISSES "ok"
        stem:false                  ·  raw LIKE 27-41 ms
                                    ภาษาไทยเป็นคำบรรยาย -> ภาษา|ไทย|เป็น|คำ|บรรยาย
                 │
                 ▼
 6 ─ SEARCH                         --bank 90 ms/162  ·  fan-out 356 ms/508 shards

     search ─┬─ --bank --repo --worktree      where
             ├─ --prose --role                who was speaking
             ├─ --since --until               when
             └─ --plain --json --jsonl        for the shell
                 │
                 ├──► show <file> --seq N     reads the SOURCE .jsonl, not the index
                 │                            (the index is a pointer, not an archive)
                 └──► trace.jsonl             every query, CLI and MCP alike
                                              which shards ever answer anything

 LEGEND   [on]/[off] = source enabled   ! = caveat   -> = flows to
 ─────────────────────────────────────────────────────────────────────────────
 rg reads all 34 GB in ~0.7 s. This index buys FACETS, not reach or speed.
```

**What the picture shows that the prose does not.** Two numbers argue with each other:
**the human is 6.8% of a transcript**, and **340 of 345 shards had never produced a best
hit** when that log was read (2026-09-18, 51 queries, median 151 ms). Six stages carefully
preserve 3.26 M events, and the query log says nearly all the value sits in five shards
and one-fifteenth of the content. That is an argument for indexing *less*, not faster.

A third number joined them with banks: **34 GB of transcripts compress to a 2.7 GB
index**, and three of the six banks are overlapping snapshots of the same machine. Some
of what is stored is stored twice, deliberately — see Banks below.

---


## Banks

A **bank** is one whole source root, and it is the top level of the shard path:

```
~/.relic/banks/<bank>/github.com/<org>/<repo>/
         │        └─ one git repo, ghq-style — a LanceDB directory
         └─ one source root: a Claude projects dir, codex, omp, memory
```

**Why a bank exists.** This machine has three Claude projects roots — the live one, an
archive, and a dated snapshot. They are **overlapping copies of the same machine**, not
three different machines. Without a bank they collapse into one shard per repo, and the
question "which snapshot did this come from" becomes unanswerable after the fact.

**The same session can therefore exist in two banks, as two physical rows.** That is the
design, not corruption: 3,258,529 events across six banks is *more* than the 3,238,933 of
the old flat index, because the duplicates are now stored twice on purpose.

What each surface does about that duplication is not the same, and the difference matters:

| | duplicates |
|---|---|
| `relic search` / `relic_search` | **collapsed** — keyed on `(ts, role, text)` |
| `relic sessions` / `relic_sessions` | **not collapsed** — a cross-bank copy shows as an extra transcript |

> The dedup key is content, **not `uid`**. `uidOf` hashes a *line slot*, so a resumed
> session writes a new file under the same uuid whose slot 7 holds a different event.
> Measured: of 13 real cross-root pairs, 8 diverge at line 1, and one pair had 1,018
> slots carrying a different indexed event in each copy. A uid-keyed dedup shipped
> first and silently dropped real results; it was reverted.

`--bank <name>` (CLI) and `bank` (MCP) match **exactly**, not as a substring, and are the
cheapest filter available — measured on this index, `--bank projects-archive` is **90 ms
over 162 shards** against **356 ms over 508** unfiltered.

`relic status` prints the banks on this machine. Don't hardcode the list; it changes when
a source is added.

---

## Sources

Nine declared, six on by default. Each declares how to find its files, how to parse them,
and which bank it writes.

| source | bank | shape | default |
|---|---|---|---|
| `claude-live` | `projects` | JSONL, 3 tiers (session/subagent/workflow_agent) | on |
| `claude-archive` | `projects-archive` | same | on |
| `claude-1sep` | `projects-1sep-tue2026` | same — the largest root | on |
| `codex` | `codex` | JSONL rollouts, date-nested | on |
| `omp` | `omp` | JSONL, one dir per encoded cwd | on |
| `claude-memory` | `memory` | `<project>/memory/*.md`, typed facts | on |
| `oracle-vault` | `vault` | `ψ/**.md` documents | off — path is per-machine |
| `hermes` | `hermes` | **SQLite**, one DB per profile | off |
| `omx-logs` | `omx-logs` | run logs — ops output, not conversation | off |

`relic sources` prints this for *your* machine, with what is actually present and how many
banks a run would write.

### Hermes is SQLite, and that is not the omp mistake

The omp source exists because a prior survey called it "SQLite-only" after measuring
the directory and reading a filename — the JSONL was sitting right beside the DB.
Hermes was re-checked against that lesson and the classification holds: its only
`.jsonl` files are a tool log and a curator ledger, and `sessions/` is a single
`sessions.json`. There is no per-session JSONL.

**One DB holds many sessions**, which `Parser` does not — it is one file → one session.
Rather than special-case a DB source through the whole pipeline, the walker emits one
entry per session with a synthetic path:

```
/Users/you/.hermes/profiles/<profile>/state.db#<session_id>
```

Manifest, uids, `show` and `read` all work unchanged. `mtime` is the session's own
`last_activity_at`, **not** the file's — a live SQLite file's mtime changes constantly
while its rows mostly do not, so keying on the file would re-import everything every run.

Facets come from the `sessions` row, which carries real `cwd`, `git_branch` and
`git_repo_root` — so Hermes sessions shard into the correct repo exactly like a
transcript, with no path guessing.

Noise filtering is declarative here rather than heuristic: `active = 1` and
`compacted = 0` are exact column predicates, unlike `--skip-noise`, which has to infer
from text shape.

## Two front ends: TypeScript (reference) + optional native binary

`bunx` keeps working with **no Rust toolchain and no build step** — the native
binary is strictly optional.

```bash
bunx github:Soul-Brews-Studio/agents-relic status     # TS, nothing to install
cargo build --release --manifest-path rust/Cargo.toml  # optional, ~2s (zero deps)
./bin/relic-dispatch.sh now                            # native when present, TS otherwise
./bin/relic-dispatch.sh banks                          # bank names
./bin/relic-dispatch.sh shards --bank codex --count    # 47
```

Native implements the **index-free** paths: `now`, `banks`, `shards`. Enumerating
shards is pure `readdir` — which bank directories exist, and which repos under each —
so it needs no engine and stays in the zero-dependency default build.

Measured on this machine, 508 shards across 6 banks:

| | answers | time |
|---|---|---|
| `relic-native shards --count` | which shards exist | **22 ms** |
| `bun src/cli.ts --help` | nothing — startup floor | 79 ms |
| `uv run relic-py --help` | nothing — startup floor | 570 ms |

The native binary finishes the whole enumeration in less time than either runtime
takes to print its own help. Counting ROWS inside those shards is a different
question and still belongs to the engine — see below.

### Why only *some* commands are native

The split follows whether a command needs LanceDB, not a blanket "Rust is
faster" assumption:

| path | native build | measured |
|---|---|---|
| **index-free** (`now`) — readdir + mtime only | zero dependencies, 14s build | **~0.00–0.01s vs 0.82–1.87s** for Bun |
| index-backed (`session`, `search`) | needs lance+datafusion, ~500 crates, multi-minute build | roughly a wash |

The reason index-backed commands barely move: **TS, Python and Rust all wrap the
same Rust `lance` core.** The query costs the same in every one of them — a
native build saves only the host-language startup slice, not the query. A Python
spike against the identical shard showed the same ~1.2s query as TS.

So `rust/` defaults to **no engine dependency at all** (`default = []`). Opt in
with `--features index` only if you have a reason.

### Traps found building this

- `lancedb 0.39.0` **does not compile** without `features = ["remote"]` — its
  `job.rs` references `Error::Http`, a variant `error.rs` only defines under
  that feature. Undocumented; found by bisecting flags.
- `lto = true` on the lance+datafusion tree turned linking into a
  machine-saturating step (observed system load >200) for no measured gain on
  read paths bounded by query time. It is off deliberately.
- `bun build --compile` is **not** a shortcut here — the compiled binary
  measured ~2s steady-state and 291 MB, *slower* than plain `bun src/cli.ts`,
  because the LanceDB native addon has to be loaded out of the bundle each run.

### The rule this split enforces

The TypeScript CLI is the reference implementation and owns every write path
(index, import, cache). The native binary implements read paths only. Anything
not implemented natively **falls through to TS** rather than being
reimplemented — two copies of the parser or the schema is the maintenance trap
this design exists to avoid.

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
relic status                   # what you ended up with, and when it last ran
relic pending                  # what is on disk but NOT indexed  <- the real check
```

**Run `relic pending` after any index.** `relic status` reports what was imported and
never what was missed, so a partially-indexed corpus looks completely healthy. This is
not hypothetical: an index run with `--since 7d` left 3,591 workflow_agent + 427 subagent
+ 361 session files unseen while `status` showed 3 M events. `pending` caught it.

Everything lands in `~/.relic/banks/<bank>/github.com/<org>/<repo>/`. Nothing is written
into any repository. Use `--in-repo` if you want each repo to carry its own shard.

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

### Fan-out cost, and what it is not

An unfiltered search asks all 508 shards. They are queried concurrently, capped at
`min(16, cpus-2)` — unbounded would trade a latency problem for a file-descriptor one.

Measured on `"peak concurrency"`, average of 3 runs each (single runs vary by ~2 s, so
one-shot comparisons of this are worthless):

| fan-out cap | |
|---|---|
| 1 (sequential) | 9,211 ms |
| **16 (default)** | **6,206 ms** |
| 32 | 6,762 ms |
| 64 | 5,972 ms |

Concurrency buys ~1.5x and nothing reliable above 16, because the cost is 508 real FTS
queries. **`--repo` is still worth far more than any cap** — one shard answers in ~330 ms.
`RELIC_FANOUT` overrides the cap for measurement.

### Duplicate events across transcripts

Resuming a session forks a NEW transcript and copies the history forward, so the same
event lives in two files. relic's `uid` is `(source, filename, seq)`, so a copied event is
two legitimate rows and both used to surface — **213 duplicate rows out of 2,403 hits
(8.9%)** on one query.

Results are deduped on `(ts, role, text)`: a millisecond timestamp plus identical content
is the same event, not a coincidence. The sort runs first, so the copy that survives is
the best-ranked one.

What this deliberately does **not** collapse: a subagent's own turn (`user` / `subagent`)
and the parent receiving it (`tool_result` / `session`) share text and timestamp but are
two different events, and the role tells you which is which. Six such pairs remain in
2,196 hits, correctly.

### Ranking across shards

relic shards by (bank, repo), so a fan-out asks 508 indexes and each returns its own
top-`limit`.
Those results are **sorted by BM25 score before slicing** — without that step the "top 20"
is whatever the first shards happened to hold.

Measured on `"peak concurrency"`, 345 shards, 1,493 hits, before the sort existed:

| | shown | actual best |
|---|---|---|
| overlap of the two top-10s | **1 / 10** | |
| repos represented | 1 | 5 |
| best score | 14.46 | **19.84** |

LanceDB returned `_score` on every hit the whole time; the code discarded it.

**Honest limit:** BM25 is computed per index, so IDF reflects each shard's own corpus and
scores are not strictly commensurable across shards. Same engine, same tokenizer, same
schema makes them close enough to beat arrival order by a wide margin — but this is a
ranking improvement, not a globally correct BM25. A true global ranking needs corpus
statistics relic does not keep.

### `sessions` — list and count

```bash
relic sessions --repo my-repo --since 24h --count     # → 64 sessions
relic sessions --repo my-repo --since 24h             # list, newest first
relic sessions --since 24h --plain | cut -f1             # just the session ids
```

Shows start time · short uuid · `+N` children · tree event count · repo · `[worktree]`,
with the session's **name** beneath it.

**One row per conversation, not per file.** A fan-out that spawned 110 workflow agents
is 111 transcripts sharing one uuid; ungrouped it reads as 111 sessions and the listing
fills with agent prompts instead of the human's. Measured here: 325 transcripts over
three days are **24 real conversations**. `--all-tiers` turns grouping off.

Filters on `started_at` — the session's own first timestamp — **not** file mtime, which
moves on every append and would make an old session look new.

### `dig` — the fleet's session timeline, with the tier it was missing

```bash
relic dig 20 --deep                      # newest 20, all three tiers, as JSON
PROJECT_DIRS="$dirs" relic dig 0 --deep  # drop-in for `python3 dig.py 0 --deep`
```

Emits the same JSON contract as `~/.claude/skills/dig/scripts/dig.py` — session entries
in start order, gap sentinels interleaved, trailing coverage entry — so the `/dig`
skill's renderer works unchanged. It is a TypeScript reimplementation and never shells
out to Python.

Head-to-head on one project directory, same input:

| | `dig.py --deep 0` | `relic dig --deep 0` |
|---|---|---|
| entries returned | 13 | **118** |
| `gitBranch: "unknown"` | 13 / 13 | **0 / 118** |
| tiers seen | session, subagent | session, subagent, **workflow_agent (105)** |

Three measured causes:

- **The workflow tier.** `dig.py --deep` globs `<uuid>/subagents` for `.jsonl` and never
  descends into the workflow run directories beneath it. A fan-out is invisible to it —
  here that is 105 of 118 transcripts.
- **`gitBranch`.** dig.py reads it only from a `type:"summary"` record. Sampled over the
  120 newest transcripts across both roots: summary records **0/120**, `gitBranch` on
  ordinary records **120/120**. Its branch column reads `unknown` for every current
  session while the value sits on every line.
- **`sessions-index.json`**, its other metadata source, exists in **59 of 1,527** project
  directories (3.9%).

Deep mode adds two fields the Python has no equivalent for: `tier` (which of the three,
not a yes/no `isSubagent`) and `workflowRunId`, which groups a fan-out back together.

**Cached, because history does not change.** A finished transcript never changes, so it
is parsed once. The key is `(path, mtime, size)` — the same import-diff identity the
index uses, no content hashing (hashing 56 MB to avoid parsing 56 MB saves nothing).

| `relic dig 1000 --deep` | time | cache |
|---|---|---|
| cold, empty cache | 6.79 s | 0 / 1000 |
| warm | **0.63 s** | **999 hits, 1 miss** |

The one miss is the session still being written — invalidation working, not a gap. The
cache holds 1000 entries in 0.6 MB at `~/.relic/dig-cache.json`, written atomically
(write-then-rename: two overlapping digs must not leave a half-written file that still
parses as JSON). `--no-cache` bypasses it.

Enumeration is the floor and is never cached: 37,496 candidates across 1,527 project
directories cost **0.82 s** of `readdir` + `stat`, and that walk is what *detects* the
change, so skipping it would be skipping correctness.

What this deliberately keeps: the scan is over **files, not the index**. `dig` answers
"what happened recently" across whatever is on disk, including transcripts nothing has
imported yet, and routing it through the index would narrow that.

Every path is checked before it is stat'd. Archived roots are full of symlinks into the
live root which dangle once a session is pruned there; dig.py records an incident where
one bad link aborted a scan of 38,764 files and emitted zero sessions — reading as "no
history". The same thing broke a probe written while building this.

### Times are local, everywhere

Transcripts store `timestamp` as ISO-8601 UTC and relic stores that string **verbatim** —
a stored local time is a stored lie the moment it crosses a machine. But display was
slicing the ISO in some commands and converting in others, so `relic session` reported
the same session starting at `10:06` while `relic dig` said `17:06`. Same index, same
session, 7 hours apart, neither labelled.

One formatter (`src/time.ts`) now feeds every human-facing line, and the offset is named
in the header (`UTC+07`). Machine output — `--json`, `--jsonl`, `--plain` — keeps the raw
ISO untouched, because that is what gets diffed.

`relic session` also reports when the **index is behind the file**:

```
(!) index is 61m behind this file — it has grown since import.
```

relic stores a pointer, not an archive, so a live session keeps growing after import.
That is by design, and it only becomes a trap when two commands are compared and the
difference is mistaken for a timezone bug — which is exactly how it was found.

### `now` — what is running, and which session am I in

```bash
relic now                       # this session: id, live agents, activity timeline
relic now --all                 # every session written to recently, machine-wide
relic now --all --window 900    # widen "recently" to 15 minutes
relic now --plain               # just the current session id, for scripts
```

```
7 sessions active in the last 15m

   4s ago  04d1d650    0 live agents  Jsonl app in ralph-dig
            /opt/Code/github.com/laris-co/neo-oracle/wt/neo-jsonl-big-boss-16sep-wed2026
  23s ago  1f3db67f    0 live agents  Facebook reel frames
            /opt/Code/github.com/laris-co/nexus-oracle/wt/nexus-kiosk-flutter-app-18sep-fri2026
```

**This is the one command that does not touch the index.** Liveness is file mtime: a
transcript being appended to right now cannot be inside an index that already ran, so
anything derived from LanceDB is stale by construction. An agent that is running is an
agent whose transcript is growing.

**Finding the current session is a lookup, not a search.** The project-directory
encoding maps both `/` and `.` to `-`, so *decoding* it is lossy and relic never does —
but *encoding* is deterministic. `relic now` computes the directory name from cwd and
reads the newest file in it, walking up from a subdirectory to the directory the agent
was actually started in. The result is verified against the transcript's own `cwd` field
and flagged `(!)` rather than asserted when they disagree — the encoding is not
injective, so two checkouts can collide.

Machine-wide scan of 781 project directories: **0.63 s**.

### `session` — one session, by id **or by name**

```bash
relic session 04d1d650                      # by id, or any prefix of one
relic session "ralph-dig" --repo neo-oracle # by name
relic session 04d1d650 --limit 20           # more transcripts listed
relic session 04d1d650 --no-neighbours      # skip the either-side block
```

Claude Code names its own sessions — it writes `{"type":"ai-title","aiTitle":...}`, the
label its resume picker shows. relic stores that as `title`; anything without one falls
back to the opening message, with slash-command markup unwrapped so `/dig deep find …`
reads as itself rather than as `<command-name>` tag soup.

`relic session <arg>` tries the argument as an id first, then on disk, then as a name.
A name that matches several sessions lists them all rather than guessing one.

```
Jsonl app in ralph-dig

04d1d650-031a-44f6-9c22-3e400e68390f  ·  matched by name  ·  laris-co/neo-oracle [neo-jsonl-…]
2026-09-16 10:06 → 2026-09-18 09:27  ·  117 transcripts  ·  5,840 ev  ·  5 workflow runs
  workflow_agent 105 · subagent 11 · session 1  ·  claude-sonnet-5

same worktree, either side:
   2026-09-16 10:05  b658931d       2 ev  ok
>> 2026-09-16 10:06  04d1d650    1487 ev  Jsonl app in ralph-dig
```

**The either-side block is the point.** The question right after "which session was
that" is almost always "and what came before it" — a session is one stretch of a longer
thread of work. Answering it from a session row alone means going back to the index with
a hand-built time filter, which is exactly the improvisation the tool exists to remove.
Scoped to the same worktree, because that is the unit of work.

Adding `title` did **not** require reindexing 345 shards. `upsert` compares the row's
keys against the table schema and calls `addColumns` for what is missing, backfilling
old rows with a default — so an old shard keeps answering and fills the column in as its
sessions are re-imported.

### `chain` — what ran in parallel

```bash
relic chain 04d1d650                 # every transcript the session spawned, on a time axis
relic chain 04d1d650 --limit 4       # cap rows per group
relic chain 04d1d650 --width 60      # wider bars
```

A session is not a line, it is a tree: the parent transcript, the subagents it spawned
directly, and one group per workflow run. `sessions` can only sort those by start time,
which hides the thing worth knowing — how many were running **at once**.

```
04d1d650 · 117 transcripts · 2026-09-16 10:06 → 2026-09-18 09:09
wall 47.0h · agent-time 52.3h · 1.1x parallel

wf_8c815d81-6ef   10 transcripts · 10:40–10:42 · 2m · peak 10 at once
  10:40 agent-adac9b749f457960 |▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬|    2m    10ev
  10:40 agent-a6b7a0aebb23b6d6 | ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬|    2m     8ev
                               10:40──────────────────────────────10:42
```

Two numbers carry the answer:

- **`agent-time` vs `wall`** — summed duration against elapsed span. It can only exceed
  wall time when work genuinely overlapped, so the ratio *is* the parallelism.
- **`peak N at once`** — an edge sweep over start/end times, not a row count. Ten agents
  that ran one after another have peak 1.

**Each group is scaled to its own span, not a shared axis.** A 47-hour parent session on
a shared axis compresses a 2-minute workflow to one cell and the overlap disappears —
the single thing the view exists to show. Bars compare within a run, never across.

`journal.jsonl` rows are dropped: a workflow directory holds one, it has no events and no
clock, and it renders as a zero-length bar at the origin of every group.

### `show` — read the surrounding conversation

```bash
relic show <file> --seq 224 --before 3 --after 3
```

Every search result prints its own `-> show …` line; copy it. Reads the source `.jsonl`
directly, because the index stores a **pointer**, not an archive.

### `status`, `pending`, `memory`, `sources`, `trace`

```bash
relic status                 # bank → repo, counts, and BOTH clocks
relic status --bank codex    # one bank
relic pending                # on disk but not indexed: missing vs changed
relic pending --list 20      # NAME them: session id, repo, bank, newest first
relic memory                 # Claude's own memory, joined to the sessions that made it
relic sources                # configured sources and what is actually present
relic trace                  # your own query log
relic trace --cloud          # keyword cloud, log-scaled by how often you ask
```

**`status` reports two clocks, and conflating them is the trap:**

```
  projects   16,000 sessions · 156,665 events · 52 shards
             indexed 2026-09-18 21:04 · newest session 2026-09-18 20:40
```

`indexed` is `max(files.imported_at)` — when the **indexer** last wrote here. `newest
session` is `max(sessions.started_at)` — when the newest **transcript** began. They
diverge exactly where it matters: reindexing an old corpus moves the first and leaves the
second months back, and an index that has not run since Tuesday still shows a recent
second because a session started before it ran. **Only `indexed` answers "is this
current".** A real row from this machine:

```json
{ "repo": "github.com/Soul-Brews-Studio/mawjs-oracle",
  "lastIndexed": "2026-09-18T13:57:25.167Z",
  "newestSession": "2026-06-02T13:51:28.393Z" }
```

Fresh index, three-month-old material — both true, neither a fault.

**`pending --list N` names what is missing**, newest first:

```
  when             session    state   bank      source/tier          repo
  2026-09-18 21:30 04d1d650   changed projects  claude-live/session  laris-co/neo-oracle
  2026-09-18 21:15 7ba99d4d   changed projects  claude-live/session  dryoungdo/mycelium-oracle
```

`missing` = never seen. `changed` = seen, and modified since — the normal state of any
live session, not a fault.

The counts are a `stat()` sweep over the whole corpus; only the listed `N` are opened.
A file's repo is **not** knowable from its path (the encoded project-dir name maps both
`/` and `.` to `-`, so two checkouts can share one directory), so it is read from each
transcript's own `cwd`. That is why the list is opt-in and capped.

Omit `--since` when the question is "is anything missing" — a `--since` scan structurally
cannot see a file older than the span.

All three speak `--json`, `--jsonl` and `--plain`:

```bash
relic pending --list 50 --plain     # sessionId<TAB>repo<TAB>bank<TAB>source/tier<TAB>state<TAB>path
relic status --json | jq '.rows[] | select(.bank=="codex")'
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

## MCP — the same lookups, for a model

```bash
claude mcp add relic -- bun /path/to/agents-relic/src/mcp.ts
# or, if `relic` is on PATH:
claude mcp add relic -- relic mcp
```

Eight tools, each one deterministic lookup with named parameters:

| tool | answers | `bank` |
|---|---|---|
| `relic_now` | what is running right now; **how a model learns its own session id** | — |
| `relic_status` | what is indexed — **call first**; the only place both filter vocabularies are discoverable | yes |
| `relic_pending` | what is on disk but **not** indexed, and which sessions those are | yes |
| `relic_search` | full-text over transcripts; returns `file` + `seq` pointers | yes |
| `relic_sessions` | what was I working on, over a time range | yes |
| `relic_session` | one id **or name** → the tree, its stats, and the sessions either side | yes |
| `relic_chain` | what ran in parallel inside that session | yes |
| `relic_show` | the conversation around one hit, read from the source `.jsonl` | — |

**`relic_status` groups bank → repo and says which column each filter reads.** It used to
claim its rows were the values `repo` accepts. After banks those rows read
`projects/github.com/org/repo`, while `repo` matches the repo portion only — so a model
following the tool's own instructions got zero hits, from the one tool whose job is
saying what is valid. A bank **heading** is what `bank` takes (exact); an indented repo
**row** is what `repo` takes (substring).

**`relic_pending` exists because `relic_status` cannot answer "is the index complete".**
It reports what was imported, never what was missed. With `list: N` the pending sessions
are named, each with its session id and the repo read from that transcript's own cwd.

**Why this exists: a model should not improvise a query.** Without tools, "find session
1f3db67f" becomes a guessed `find` or a `grep -r` over 25k transcripts — slow, often
wrong, and a different command every time. These name the lookup instead.

**Both front ends call `src/query.ts`.** The CLI renders those results for a human, MCP
serialises them for a model; neither reimplements a query. A second copy drifts, and the
copy a model gets is the one no human ever runs by hand.

Two behaviours worth knowing:

- **Narrowing is not cosmetic.** Measured on this index at 508 shards: unfiltered is
  **356 ms**, `bank=projects-archive` is **90 ms over 162 shards**, and a single `repo`
  is one shard. Every tool description that takes `repo` or `bank` says so, so the model
  narrows by default. (An earlier measurement at 345 shards, before shards were queried
  concurrently, put the unfiltered fan-out at 10.7 s.)
- **MCP queries land in the same trace log** as CLI ones. Otherwise `relic trace`'s
  "which shards ever answer anything" question silently loses every query a model made —
  which, once an agent is using this, is most of them.

Environment: `RELIC_DATA_ROOT` to point at another index, `RELIC_IN_REPO=1` for in-repo
shards. Both match the CLI flags.

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
      "bank": "projects-1sep-tue2026",
      "note": "older snapshot root"
    }
  ]
}
```

`walk` is `claude-tiers` (the three-tier Claude layout), `flat` (recursive file walk),
`omp`, `vault`, `memory` or `hermes`. `shape` is `claude` or `codex`.

**`bank` decides where the rows physically land.** Omit it and the source writes into
`default`, sharing a shard with anything else that did the same — exactly the collapse
banks exist to prevent when one root is a *snapshot* of another. Give any source that
overlaps an existing one its own bank name.

Duplicate keys and duplicate banks are dropped with a warning on stderr rather than
silently merged; `relic sources` reports how many banks a run would write.

Built-in and on: `claude-live`, `claude-archive`, `claude-1sep`, `codex`, `omp`,
`claude-memory`. Built-in and **off**: `oracle-vault` (path is per-machine), `hermes`,
and `omx-logs` (those `.jsonl` files are ops logs, not conversation, and indexing them
floods search with noise).

---

## Data model

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  relic — data model and its joins                        measured 2026-09-18 ║
║  3 tables · 0 foreign keys · file_path is the real key, session_uuid is not  ║
╚══════════════════════════════════════════════════════════════════════════════╝

 ONE LANCEDB DIR PER (BANK, REPO)  ~/.relic/banks/<bank>/github.com/<org>/<repo>/

                       ┌──────────────────────────┐
                       │  files      1,881 rows   │   THE MANIFEST
                       │  ─────────────────────   │   written PER FILE, so Ctrl-C
                       │  file_path   PK  UNIQUE  │   resumes instead of restarting
                       │  repo_key                │
                       │  mtime  size             │   (path,mtime,size) = the import
                       │  imported_at             │   diff. No content hashing.
                       └────────────┬─────────────┘
                                    │  file_path   1:1
                                    ▼
                       ┌──────────────────────────┐
                       │  sessions   1,881 rows   │   ONE ROW PER TRANSCRIPT FILE
                       │  ─────────────────────   │
                       │  file_path   PK  UNIQUE  │◄── the join everything uses
                       │  session_uuid    153 !!  │    NOT unique — see below
                       │  tier  source            │    session|subagent|workflow_agent
                       │  cwd  worktree  repo_key │    identity, from the JSONL
                       │  started_at  ended_at    │    the session's OWN clock,
                       │  event_count  line_count │    never file mtime
                       │  description             │    first user message
                       └────────────┬─────────────┘
                                    │  file_path   1:N   (avg 63 events/file)
                                    ▼
                       ┌──────────────────────────┐
                       │  events   118,780 rows   │   ONE ROW PER INDEXED BLOCK
                       │  ─────────────────────   │
                       │  uid         PK  UNIQUE  │   sha1(source, BASENAME, seq)
                       │  file_path       FK→     │   path EXCLUDED on purpose:
                       │  session_uuid            │   same file under two roots
                       │  seq                     │   dedups instead of doubling
                       │  role                    │   labelled by BLOCK, not envelope
                       │  ts  text                │
                       │  repo_key worktree cwd   │   denormalised so a filter can
                       │  source  tier            │   push down into the FTS scan
                       └────────────┬─────────────┘
                                    │
                            text_idx(text)          ICU · stem:false · maxToken 128
                                    │
                                    ▼
                               BM25 search

 ── NO FOREIGN KEYS EXIST ────────────────────────────────────────────────────
    LanceDB does not have them. Every edge above is a CONVENTION the writer keeps,
    not a constraint the store enforces. Nothing stops an orphaned event, so
    deleteEventsOf(file) runs before re-import — a SHRINKING file would otherwise
    leave rows behind that no session row points at.

 ── session_uuid IS NOT A KEY ────────────────────────────────────────────────
    1,881 files  ->  153 distinct session_uuid       22 uuids span >1 file
    Subagent and workflow-agent transcripts INHERIT the parent's uuid, so a uuid
    identifies a session TREE, not a file. Filtering by it returns the parent plus
    every child. Use file_path when you mean one transcript.
    (The same collision makes an 8-char uuid prefix unsafe as an identifier.)

 ── WHAT IS NOT STORED ───────────────────────────────────────────────────────
    No full text of a file that exists on disk (--skip-noise drops readbacks).
    No vectors yet — they land in `events`, same table, no migration.
    The index is a POINTER: (file_path, seq) -> `show` re-reads the source .jsonl.

 SIDECARS   ~/.relic/trace.jsonl    one line per query, + `opened` on show
            ~/.relic/skipped.jsonl  one line per dropped event, with the rule
            both JSONL on purpose: relic can index its own logs, no new reader

 LEGEND  PK = key in practice   FK→ = join by convention, unenforced   !! = trap
```

**The reveal.** `session_uuid` looks like the primary key and is **12:1 non-unique** —
1,881 files carry only 153 distinct uuids, because subagent and workflow-agent
transcripts *inherit* the parent's. A uuid identifies a session **tree**, not a
transcript, so filtering by it returns the parent plus every child. Use `file_path` when
you mean one transcript. The same collision makes an 8-character uuid prefix unsafe as
an identifier.

And there are **no foreign keys at all** — LanceDB has none, so every edge is a
convention the writer keeps. That is why `deleteEventsOf(file)` runs before re-import: a
shrinking file would otherwise strand events no session row points at, and nothing in
the store would object.

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

Measured 2026-09-18 at **508 shards / 3,258,529 events / 40,865 sessions**, index 2.7 GB
over ~34 GB of raw transcripts:

| command | latency | shards read |
|---|---|---|
| `search --repo <one>` | ~200 ms | 1 |
| `search --bank projects-archive` | **90 ms** | 162 |
| `search` (unfiltered) | **356 ms** | 508 |
| `status` (with both clocks) | **1.42 s** | 508 |
| `pending` (whole corpus) | **1.37 s** | 40,865 files scanned |
| `pending --list 5` | 1.8 s | + 5 files opened |
| `memory` (198 memories joined to sessions) | 1.73 s | 508 |

Latency scales with **shard count**, not corpus size — which is what makes `--bank` the
cheapest filter: it cuts the shard set without knowing anything about the query.

An honest caveat: `rg` searches the raw JSONL in ~0.7 s. relic earns its place through
**facets and structure** — bank, repo, worktree, role, date, session listing — not
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
