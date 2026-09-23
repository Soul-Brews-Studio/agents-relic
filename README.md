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
║  8 banks · 817 shards · 3,394,951 events · 167,853 sessions · 3.2 GB         ║
╚══════════════════════════════════════════════════════════════════════════════╝

 1 ─ SOURCES                        config: ~/.relic/sources.json, no code change

     ONE SOURCE = ONE BANK.       a bank is the top level of the shard path

     source              raw     bank                     index   events
     ~/.claude/projects  3.7 G   projects                  366 M   402,944
     …/projects-archive  6.5 G   projects-archive          737 M   984,469
     …/projects-1sep     13  G   projects-1sep-tue2026     1.5 G  1,641,098
     ~/.codex/sessions   11  G   codex                     141 M   225,747
     ~/.omp/…/sessions    32 M   omp                       9.6 M     6,180
     ~/.claude/…/memory   —       memory                    2.9 M       198
     <ghq>/*/*/ψ + wt   —       vaults                    464 M   124,044
     one oracle's ψ      —       vault                      21 M    10,271
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
 3 ─ FILTER                         on by default (#37) — --keep-noise opts out, every drop logged

     file-readback    810 rows  2.64 MB   3 ascending line numbers = a file dump
     edit-payload     456       0.69 MB   the file now exists on disk
     binary-blob       55       0.20 MB   base64 (widened in #37 to any unbroken 120-char run)
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
 6 ─ SEARCH                         --bank 143 ms/47  ·  fan-out 547 ms/817 shards

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

A third number joined them with banks: **34 GB of transcripts compress to a 3.2 GB
index**, and three of the eight banks are overlapping snapshots of the same machine.
Some of what is stored is stored twice, deliberately — see Banks below.

A fourth arrived with the ports. This index is now read by **three** implementations
— TypeScript, Python and Rust — and the second and third found six bugs the first
could not, because one implementation cannot disagree with itself. See
[Three readers](#three-readers-one-index).

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
design, not corruption: 3,394,951 events across eight banks is *more* than the 3,238,933 of
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

## Agent homes — `CLAUDE_CONFIG_DIR`, `CODEX_HOME`

Claude Code takes its home from an env var, and the binary (v2.1.278) is unambiguous:

```js
function s(){ return process.env.CLAUDE_CONFIG_DIR }
(s() ?? join(homedir(), ".claude")).normalize("NFC")
```

**One path, not a list**, NFC-normalised. Codex does the same with `CODEX_HOME`. So an
agent home is a single identity — and that is the right thing for a bank to be.

The builtin sources get this axis wrong, and it shows: `projects`, `projects-archive`
and `projects-1sep-tue2026` are three banks for roots inside **one** home (`~/.claude`),
while `peer-projects` is one bank for a whole **other** home. That model cannot say
"index this other home", which is how `~/.claude-neo` sat on this machine with real
sessions and zero indexed rows.

Declare a home instead:

```json
{ "homes": [
    { "key": "claude-neo", "path": "~/.claude-neo" },
    { "key": "claude-nat", "path": "/Users/nat/.claude" },
    { "key": "codex-alt",  "path": "~/.codex2", "agent": "codex" }
] }
```

Each Claude home expands to two sources — transcripts (bank `<key>`, the `claude-home`
walk covering **every** `projects*` root inside it) and typed memory (bank
`<key>-memory`). A Codex home expands to one, over `<home>/sessions`.

Enumerating `projects*` also removes a hand-maintained list, and that list has failed
before: `projects-1sep-tue2026` lived only in a `sources.json` that got deleted, so a
rebuild indexed two of three roots and reported success.

**Why one source per reading rather than one per root:** two sources sharing a bank is
exactly what the duplicate-source guard exists to catch, and it has caught a real
incident. One home therefore gets one source whose walker covers its roots, not three
sources pointed at one bank.

**The env vars are reported, never followed.** `relic sources` prints what
`CLAUDE_CONFIG_DIR` / `CODEX_HOME` point at and flags a home no enabled source reads:

```
agent homes this environment points at:
  [MISSING]  CLAUDE_CONFIG_DIR=/Users/beta/.claude-neo
           no enabled source reads this home — declare it:
           ~/.relic/sources.json  { "homes": [{ "key": "<name>", "path": "…" }] }
```

Acting on it silently is the failure being avoided: relic would index the *default*
home, find plenty, and print a clean summary for the wrong agent's history — and on a
shared machine, write another account's transcripts into a bank named for this one.

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
| `oracle-vault` | `vault` | ONE oracle's `ψ/**.md` | off — path is per-machine |
| `oracle-vaults` | `vaults` | EVERY `<org>/<repo>/ψ/**.md` under the ghq tree, worktree vaults included | off |
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
`compacted = 0` are exact column predicates, unlike noise filtering, which has to infer
from text shape.

**No transcript file means the live views cannot find it by walking directories.**
`now --all` and a no-argument `tail`/`recap` walk project directories, and Hermes has
none, so they read `state.db` instead, through a parallel lookup rather than
`liveRoots()`. The clock is each session's newest active message:

- `now --all` lists every Hermes session with a message inside the window. A spawn
  (`parent_session_id`) counts as its parent's live agent, not as a row of its own.
- A no-argument `tail`/`recap` also considers Hermes sessions that ran in **this
  checkout**: the same repo key AND the same worktree. With the repo key alone, a sibling
  worktree's session would outrank this one's own transcript. They are ranked with the
  transcripts, so the newest session wins whichever agent wrote it. When relic runs
  inside a Hermes session, that session is skipped: Hermes sets `HERMES_SESSION_ID` on
  every command it runs.
- A gateway session (Discord, say) records no cwd, so no directory can claim it. When
  the directory has nothing worth reading and `HERMES_SESSION_ID` is set, `tail`/`recap`
  follow the caller's own line instead: the session immediately before it on the same
  `session_key`, the same line `lineage` draws. This is a fallback, never a first
  choice. A Claude session started from a Hermes shell inherits the variable, and the
  environment cannot say which agent is innermost.
- `now` names a Hermes caller by the same variable, and `lineage` with no id draws its
  line. Hermes ids are not hex, so they get their own shape check. The Claude and Codex
  checks are unchanged, and those two still win when both are set.

Only an enabled `hermes` source is read. When a lookup comes up empty and `~/.hermes`
holds data with the source switched off, the miss message says so.

## Three readers, one index

The same `~/.relic` is read by three implementations. This is not redundancy — it is
the only test that catches a whole class of bug, because **one implementation cannot
disagree with itself**.

| | lines | commands | direct deps | what it is |
|---|---|---|---|---|
| **TypeScript** | 6,305 | 20 | 3 | the **reference**. All writes, the MCP server, the thing `bunx` runs. |
| **Python** (`python/`) | 4,415 | 20 | 3 | `LanceModel` *is* the schema — the Arrow types come from the type hints. |
| **Rust** (`rust/`) | 446 | 4 | **0** | index-free paths only, ~2 s build, zero dependencies. |

```bash
bun src/cli.ts status          # reference
cd python && uv run relic-py status
./bin/relic-dispatch.sh shards --count
```

All three wrap **lancedb 0.39.0 — the same Rust core.** So "pick a faster backend" for
an engine-bound query would swap identical engines behind different wrappers. Only the
index-free scans are worth going native for, which is what `relic backend` reports.

### Six bugs the ports found

Every one of these passed the reference's own test suite.

| found by | bug |
|---|---|
| Python | `os.scandir().is_dir()` **follows** symlinks; Node's `Dirent.isDirectory()` does not. The vault walker crossed through `ψ/incubate/` into other repos' vaults — **68,719** notes discovered against the correct **10,129**. |
| Python | JS `.length` counts UTF-16 **code units**, Python `len()` counts **code points**. One emoji made the same event measure 315 vs 316 — and `truncate()` cuts at `MAX_TEXT`, so the same `uid` was stored cut at a different offset. |
| Python | `repo_key_of` lost the sibling-worktree rule → **28** shards written where the reference writes **27**. |
| Python | `context_of` was a stub → 18 of 198 session rows carried an empty `worktree`. |
| Rust | `liveSessions()` scanned `~/.claude/projects` **twice**, because `claude-live` and `claude-memory` both name it. Every running agent was double-reported, through the CLI *and* the MCP tool. |
| **the reference** | `seek.ts` never skipped `journal.jsonl`, so `relic session <id>` on an unindexed session imported one bogus `workflow_agent` row per workflow run. Python returned 162 files where TypeScript returned 169, and this session has exactly **7** `wf_` runs. |

The Rust one is the clearest case for a second implementation: **both halves of that
double-count were individually correct**, so no assertion inside the TypeScript could
have seen it.

### How parity is proved

Not "looks right". Index the same corpus with two implementations into separate
`--data-root`s, then diff **every row of all three tables by key**:

```
events    ts=6180 py=6180  only-ts=0 only-py=0  differing=0
sessions  ts=19   py=19    only-ts=0 only-py=0  differing=0
files     ts=19   py=19    only-ts=0 only-py=0  differing=0
```

Parsers are compared event-by-event on real transcripts — claude **117,962** events,
codex **62,837**, omp **5,001**, all zero-diff — and `discover()` on **49,651** files
returns the same paths. `relic chain` output is byte-identical, and both MCP servers
expose the same 8 tools.

---

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

Native implements the **index-free** paths: `now`, `live`, `banks`, `shards`. All of
them are pure `readdir` + `stat`, so they need no engine and stay in the
zero-dependency default build.

`live` is the one the TypeScript side actually calls. `liveSessions()` sweeps every
project directory under every transcript root — ~1,500 directories, thousands of
`stat()` calls — and that sweep is the entire cost of "what is running right now":
resolving ONE session is 1 ms, the sweep is 60+ ms. It is also pure syscalls, so it
parallelises across threads, which the JS runtime cannot do for blocking fs calls.

The binary returns fresh *candidates* only — project directory plus uuids. Reading
each transcript's head for cwd and title, and assembling the tree, stays in
TypeScript. A second implementation of `readdir` is cheap; a second implementation of
an output format is a second thing to drift.

```
                       RELIC_NATIVE=0        native
  freshCandidates()          62 ms            33 ms
  MCP relic_now exchange    190 ms           158 ms
```

Absent, unbuildable, non-zero exit, or wrong JSON shape → falls back to the
in-process scan. `test/native-parity.test.ts` asserts both engines return the same
candidate set, because a faster engine that returns a *different* answer is worse
than no engine at all — which answer you get would depend on whether a binary
happens to be built.

Measured on this machine, 817 shards across 8 banks:

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
relic index                          # noise filtering is on by default (#37)
relic index --keep-noise             # keep file dumps, navigation calls, blobs — old behaviour
relic index --dry-run                # count files, write nothing
```

Incremental by `(path, mtime, size)` — unchanged files are never re-read. The manifest
is written **per file**, so an interrupted run resumes rather than restarting. The one
cost of interrupting: full-text indexes are built at the end, so search falls back to a
slower scan until a run completes.

A file that is being rewritten, whether it changed on disk or the #58 re-key is
repairing it, has its manifest row marked stale **before** its old rows are deleted. A
run killed partway through the rewrite leaves the file looking changed, and the next
run finishes the job. Before this, a killed re-key left the file skipped as unchanged
and its events gone, for good.

### `--source-path` — run one source against another root

```bash
relic index --corpus oracle-vault --source-path /path/to/repo/wt/<slug>/ψ
```

`sources.ts` documented this flag before it existed — the comment told you to run a
command that fails. It exists now because a real vault needed it: a worktree vault
(`<repo>/wt/<slug>/ψ`) is a real directory, and one of them held 227 notes with index
rows and no way to rebuild them. The `vaults` walker reaches those vaults now — this
flag stays for the ones outside the ghq tree, and for pointing a source at a single
vault by hand.

It overrides **one** source's root for **one** run. The walker, parser and bank are
unchanged — that is what makes the rows land where the rest of that source's rows
already live. It is not a way to widen a walk.

Every guard it carries exists because the failure would otherwise be silent: `discover`
skips a source whose root does not exist, so a typo'd path, an unknown corpus, or two
`--corpus` values would each produce a clean `scanned 0 files` and exit 0. `prune`
refuses the flag outright — an overridden root is a different population, so every file
under the source's real root would look deleted.

### Ephemeral paths — flagged at read time, never at write time

A hit that quotes `/private/tmp/claude-501/.../scratchpad/out.mp4` is answering
correctly and pointing at a file a temp janitor deleted days ago. relic tags it:

```
  ⚠ ephemeral-path (claude-<pid> scratch root, recorded in bank peer-projects)
    — this path was session-scoped and is probably gone
```

Measured on bank `projects`, 408,886 events: **23,818 (5.8%)** reference an ephemeral
path. One event in seventeen.

Two confidence tiers, because they are not the same evidence. `/claude-<pid>/` and
`/scratchpad/` are **structural** — the pid is *in* the path, and the scratchpad is a
directory the tooling itself tears down, so each carries its own proof. A bare `/tmp`
prefix only **correlates**: a daemon configured to keep state there matches too. Same
hierarchy as the blob detection in #37 — prefer the shape that proves itself over the
prefix that merely suggests.

The note names the **bank**, because relic indexes another account's corpus and another
machine's. A path recorded under a different uid on a different host cannot be `stat`ed
meaningfully from here, which is also why there is no live check — this is pure string
work, no disk access.

**Never at write time.** "we downloaded it to /tmp and transcoded it" is exactly what a
later session needs to find. The transcript is the record of what happened; an ephemeral
path in it is information, not noise.

### `prune` — the only command that removes rows

```bash
relic prune                          # DRY RUN — names what would go, writes nothing
relic prune --apply                  # actually delete
relic prune --corpus claude-live     # limit which BANKS are eligible
relic prune --max-drop 25            # raise the per-shard ceiling from 10%
relic index --prune                  # index and prune in one pass — no second scan
```

The importer only ever adds and updates. A file that stops being discoverable — a new
skip rule excluded it, it was deleted, it moved — keeps its `events`, `sessions` and
`files` rows forever. Measured on the live index before this existed: **1,353
`journal.jsonl` rows** for a file discovery has skipped since 2026-09-18, which made
every session tree containing a workflow report one transcript too many. Two resolvers
were taught to filter `journal.jsonl` out rather than fix it — two workarounds for one
absent feature.

**This is the only code in relic that deletes rows a human did not name**, so the whole
design is the scoping. The naive version — *drop rows whose `file_path` was not seen
this run* — destroys the index on any normal invocation, because a narrowed scan is the
normal case: `--since 7d` cannot see a file older than seven days, and `--repo` never
parses most of the corpus at all.

Four gates, widest to narrowest:

| # | Gate | Why |
|---|---|---|
| 1 | the run must be **unfiltered** — no `--since`, no `--repo` | an older file is not a deleted file |
| 2 | nothing may have **failed to parse** | a file that failed is not a file that is gone |
| 3 | only shards this run **reached** are considered | a bank whose source was not in `--corpus`, or whose root was missing, is never touched |
| 4 | a shard losing more than `--max-drop` percent is **refused** | see below |

Gate 4 is not paranoia, it is a bug that already happened. `ghq.root` was unset on one
machine, so `resolveRepoKey` returned null for everything and every file resolved to
`_unresolved`. Under gates 1–3 alone that reads as *every real shard lost all its
files* — the index deletes itself and prints a clean summary. `--force` overrides it;
check the source root is fully readable first.

**A file is only "gone" if discovery found it in no shard at all.** Prune compares
against one global set, not each shard's own. Measured on the live index: two memory
notes had rows in `memory/_unresolved` and now resolve to
`memory/github.com/laris-co/neo-oracle`, because a memory note takes its cwd from the
session that produced it and that session was not indexed yet when the note was written.
Per-shard comparison calls both *deleted* — and a prune-only run writes no replacement
row, so a file that is sitting on disk ends up with nothing in the index pointing at it.
Keeping a stale row is the safe failure: `uid` already collapses duplicates at read
time. Shard migration is a different feature, and prune must not do it by accident.

Two more details that are load-bearing rather than tidy:

- **The dry run and the real run are one call with a flag**, down into
  `LanceStore.pruneFiles`. Two code paths would let the number a human approved differ
  from the number that executed.
- **`vectors` is deleted before `events`.** Its only join key to a file is through
  `events.uid`, so deleting events first strands every embedding with nothing left to
  find it by — and stranded rows are invisible, because `vectorStats()` counts rows,
  not reachable ones.

The report separates *nothing to prune* from *never looked*: shards on disk this run
did not reach are counted and named as such, because only one of those two means the
index is clean.

`relic prune` runs a full parse pass and writes nothing, which costs the same read as
an index run over an unchanged corpus. Use `relic index --prune` when you were indexing
anyway — the import has already resolved every file to its shard, so pruning then costs
one query per shard and no second scan.

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

### "N of M": M is a count only when it says so

```
20 of at least 8620 match(es) for plugin:discord:discord · 1141 shards · 1185 ms  ·  indexed 3.7h ago  ·  main sessions only — add --all-tiers for subagent/workflow work
  a floor, not a count — 488 of 1141 shards hold more than 20 matches and were not read to the end. --limit 0 reads every match.
```

Every shard answers with its own top `--limit`, so the pool behind M measures the fetch,
not the corpus. For that query M used to read 640 at `--limit 1`, 8,306 at the default
20 and 53,892 at 400; every match is **171,790**. Each shard is asked for one row past
the limit. When no shard returns it, every shard was read to the end and M is printed
bare, as a count. When any does, M reads "at least", with the line above. `--json`
carries the same as `exhaustive` and `capped` beside `total`.

A true count on every search was measured and not taken: a second, count-only pass over
the same shards adds **3.8 s** to that query when deduped the way hits are (1.7 s without
the dedupe, which counts every cross-bank copy), and 8.8 s to the widest query in the
trace log, against a 1-4 s search. `--limit 0` gives the exact number when it is wanted:
171,790 hits in 6.6 s and 4.9 GB here, so pair it with `--repo`.

### Staleness, because a stale hit looks exactly like a fresh one

```
10 of 703 match(es) for prune ceiling · 1136 shards · 376 ms  ·  indexed 77.6h ago
  ⚠ the shards that answered were last indexed 77.6h ago — newer sessions are NOT in these results.
     relic index --bank projects-archive   ·   relic status  names which bank is behind
```

An empty result announces itself. **A ranked list from a stale index does not** — it is
confident, relevant-looking, and silently scoped to whatever happened to be indexed. The
header used to report shard count and latency, neither of which changes how you read the
results.

**Scoped to the shards that produced hits.** That is the relevant population — *how
current is what answered me* — and it is the only affordable one: `freshness()`
full-scans two columns per shard at **9.1 ms**, so asking all 1,136 costs **10.3 s**
against a 1 s search. Over hit shards it measured **92 ms, 2.3% overhead**.

The cheap alternative was measured and rejected. Shard directory mtime covers all 1,136
shards in **4 ms** — 2,575× faster — but over 60 shards, 18 read *older* than
`imported_at` (safe: over-reports staleness) and **1 read newer by 3 hours**, which is
the direction that calls a stale index fresh. A staleness warning that can under-report
is worse than none, because it gets trusted.

**"Not indexed" and "no matches" are different facts.** With a `--repo` / `--bank` /
`--worktree` filter that matches no shard, the narrower the filter the likelier it
selects a slice that is entirely un-indexed — and the more authoritative the empty
answer looks:

```
no shards match --repo arra-oracle-v4 in  /Users/beta/.relic

  This is NOT "no matches" — nothing for that filter is in the index at all.
  Check what is on disk but unindexed:   relic pending --repo arra-oracle-v4
```

### Fan-out cost, and what it is not

An unfiltered search asks all 817 shards. They are queried concurrently, capped at
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

### `report` — day by day, with the shape a list cannot show

```bash
relic report                          # last 7 days
relic report --since 30d --tree       # + each session's transcript shape
relic report --repo neo-oracle --per-repo 8
```

```
2026-09-20  Sun  ──────────────  64 sessions · 169 transcripts · 19,495 ev
  laris-co/neo-oracle                    29  12,510 ev
    09:01  01a0b8e4 +2        151 ev  wt/neo-voice-bot-19sep-sat2026
          use relic read from omp to claude code ? how many app we did
    ... and 27 more in this repo (--per-repo N)
  Soul-Brews-Studio/odin-oracle           23   2,254 ev
```

`sessions` is a **feed** — most recent N, newest first. A week is a different question:
quiet days versus spikes, which repo owned a day, whether work sat in the main checkout
or scattered across worktrees. `--limit 40` truncates that before the second day starts.

Grouped **day → repo → worktree → session**, in the order the questions get asked.

**The cap is per REPO, not per day.** Per-day was the first shape and it hid the answer:
on a busy day one repo had 28 sessions and ate the whole budget, so every other repo
touched that day rendered as `... and 60 more`. A report whose cap can exclude a whole
repo cannot answer which repos a day belonged to.

**Days are LOCAL, not UTC.** `iso.slice(0, 10)` is the obvious implementation and it is
wrong: at UTC+07 a session at 01:30 local belongs to the previous UTC day, so it lands
one row early on the only axis the report exists to show.

**Transcript tiers only** — and that is the point. `sessions` holds one row per indexed
*file* of any kind, and the vault outnumbers conversations 100:1. Measured 2026-09-22
over `--since 7d`:

| tier | rows |
|---|---|
| `note` | **42,403** — ψ/*.md, one row each |
| `session` | 382 |
| `memory` | 34 |
| `subagent` | 8 |

So the unfiltered answer to "how many sessions this week" was off by 112x, and the three
enormous spikes in its daily histogram were vault *indexing* runs, not activity. `sessions`
now filters the same way; pass `--all-tiers` for the raw population.

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

Filters on the session's own event timestamps — a session is in any window it was
**active** in (`started_at` ≤ until, `ended_at` ≥ since), and its row still shows its own
start — **not** file mtime, which moves on every append, metadata included.

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

### `tail` — the last N turns, which is "what was I just doing"

```bash
relic tail 04d1d650                 # last 10 turns
relic tail 04d1d650 --role user     # last 10 things the HUMAN asked
relic tail 04d1d650 -n 3 --chars 200
```

Three commands nearly did this and none of them did: `recap <id>` is a *summary*,
`read <file>` is the *whole* transcript and needs a path rather than an id, and
`show <file> --seq N` prints raw JSON around a seq you must already know. So the
working recipe was two commands and a pipe:

```bash
F=$(relic session <id> --plain | head -1); relic read "$F" --prose | tail -40
```

**Reads the file, never the index.** "What was I just doing" is the one question where
a stale answer is worst, and the index is always at least one run behind a live
session — while building this, the current turn was in the file and not in the index.
No staleness warning is needed here for the same reason.

**Harness turns are stripped by default**, reusing `recap`'s filter. The user channel is
not the human: measured on one session, **55 of 63** user-channel turns were the tooling
describing itself. `--harness` keeps them.

**It names the role mix, because "last 10 turns" is not what people expect.** One
exchange emits many assistant messages — narration between tool calls — so a
chronological tail of a busy session is almost entirely assistant:

```
last 3 of 1,635 turns  (3 assistant)  ·  6,417 events in file  ·  read from disk, not the index
  note: no human turns in this window — one exchange emits many assistant messages.
        relic tail 04d1d650 --role user  for what was asked.
```

That is correct and unhelpful, so it says so and points at the view that answers.

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

### `skipped` — what noise filtering dropped, and the proof

```bash
relic skipped                # counts by rule, with samples of what each one ate
relic skipped --json
relic skipped --files        # paths the walk could NOT READ — nothing in them was indexed
```

Every drop is logged to `~/.relic/skipped.jsonl` with the rule that fired and the first
120 characters, because **a filter you cannot audit is a filter you cannot trust**.

The same log holds the paths discovery could not read (#99): `dir-unreadable` for a
directory it could not list or reach, `walk-error` for a single file it could not stat.
Every walker used to answer those with an empty list, so an unreadable directory looked
exactly like an empty one and `relic pending` reported `0 missing` about files it had
never seen. Now each is one stderr line per path (ENOENT stays quiet — optional
`subagents/` directories are the normal case — and so does ENAMETOOLONG, a directory
name derived from a deep cwd that is too long to exist), `index` logs them here,
`pending` says its counts cover only what the walk could read, and `prune` refuses to
run over a scan that could not see everything. The lookups report the same way:
`lineage`, `tail`/`recap` with no id, `dig`, the shard listing and the repo index.

### `embed` — the opt-in second pass

`index` never writes a vector. Embedding is a separate command over an index that is
already complete, and it is resumable, scoped, and free to skip.

```bash
relic embed --dry-run                      # what would this cost? no provider call
relic embed --repo neo-oracle --limit 5000 # a shard at a time, resumable
relic embed --model bge-m3 --reset         # change model: drops `vectors` first
relic embed --repair --bank hermes         # a shard whose `vectors` no longer reads (#105)
relic-py embed --provider st --model intfloat/multilingual-e5-small
```

**An interrupted embed.** Re-running resumes it, because the anti-join is against what
is on disk. A kill mid-write costs at most the batch in flight: Lance writes data files
first and the manifest last. One state does not resume. That is a table whose current
version references data files that are 0 bytes, which is what #105 hit. `countRows`
still answers, but every scan fails. `embed` now says so and prints the one command
that repairs that shard:

```
  hermes/_unresolved  SKIP  vectors table unreadable at v3 — LanceError(IO): Generic LocalFileSystem error: failed to fill whole buffer
                            `events` and the full-text index are untouched. To repair this shard's vectors only:
                              relic embed --repair --bank hermes --repo _unresolved
                            that restores v1 (64 of 192 vectors) and re-embeds the rest
```

`--repair` bisects the table's versions for the newest one that reads and restores it,
as a new version on top, so the history is kept. The same run then re-embeds what that
version lacks. If no version reads, it drops that one shard's `vectors`, as `--reset`
would. It never touches `events`, `sessions`, `files` or the full-text index, and it
never touches a table that reads. A dry run never repairs.

```
provider  ollama:all-minilm
scope     main tiers, text >= 24 chars, truncated at 2000

  projects/github.com/laris-co/neo-oracle   61%  74,102/120,988 embedded  dim 384

74,102 embedded · 46,886 pending · 0 failed · 1 shards · 512.0s  (145/s)
```

**Vectors go to a `vectors` table, never a column on `events`.** That is not a style
preference — it is the only shape that works:

| | |
|---|---|
| widening `events` | `addColumns` backfills a **scalar** default only, so an `embedding` column lands as `Utf8`. The TypeScript client then writes `[0.1, 0.2]` into it as the string `"0.1,0.2"` — **no error at write or read**. The Python client raises `ArrowNotImplementedError` on the same call: same Rust core, different client-side cast. Both are pinned by tests. |
| cost of a column | a column forces a value for **every** row on the next write. 3,394,951 events × 384 dims × 4 B = **4.86 GiB**, 1.5× the entire 3.2 GB index — to embed a corpus whose search already answers better without it. |
| a side table | starts absent, resumes by anti-joining `uid`, and embedding a **subset** needs no sentinel for "not embedded yet". Cost: one extra query — vector search returns uids, then `events` is read by uid. |

`widen()` now refuses a non-scalar column outright, so the first failure above can no
longer happen to any future field either.

**Providers.** `ollama` is the default in both implementations — HTTP, no dependency
added to a three-dependency tool, and identical output from either front end. Measured
locally, dim read off the live response:

| model | dim | cos(en, th translation) |
|---|---|---|
| `all-minilm` | 384 | +0.187 |
| `nomic-embed-text` | 768 | +0.467 |
| `mxbai-embed-large` | 1024 | +0.479 |
| `qwen3-embedding:0.6b` | 1024 | +0.572 |
| `bge-m3` | 1024 | +0.626 |

That cosine is a **smoke test, not a benchmark**: one English string against its Thai
translation, which says whether a model puts the two languages in one space at all and
nothing about ranking quality. `all-minilm` at +0.187 is what "English-only" looks like.

`--provider st` (sentence-transformers) reaches the models ollama does not serve —
notably `intfloat/multilingual-e5-small`, 384 dims **and** multilingual, the combination
the local catalogue lacks. **Both implementations have it**, and neither takes a
torch-sized dependency to do so: the model runtime stays in Python, and the TypeScript
side spawns `relicpy.embed_server` and talks JSON-lines to one persistent process. A
subprocess per batch would spend its life loading a model that costs ~10 s to load.

The sidecar's launcher is `uv run --with sentence-transformers`, so nothing is installed
into the repo's environment — the dependency lives for the life of the process. Verified
the same way as everything else here: both front ends embedded one 66-event shard into
separate `--data-root`s and produced **bit-identical vectors** (`max |ts − py| =
0.000e+00` over 25,344 components) under the same provider id,
`st:intfloat/multilingual-e5-small+passage:`. The id matching matters — the model-mismatch
guard compares it, so a divergence there would make each implementation refuse the
other's shards.

**Parity.** Both implementations embedded the same 66-event shard into separate
`--data-root`s with the same model. Every component of all 25,344 floats matched
exactly (`max |ts − py| = 0.000e+00`), and the two Arrow schemas compared equal.

### Embeddings, measured — and why search still does not use them

Full method and numbers: [`bench/README.md`](bench/README.md). The short version, on
200 known-item queries over a shared 3,000-doc pool:

```
FTS (ICU)                 0.890 MRR@20   R@1 83.0%   miss  2.5%     1.3 ms
multilingual-e5-small     0.600          R@1 52.5%   miss 22.0%     0.4 ms
all-MiniLM-L6 (en only)   0.503          R@1 42.5%   miss 30.5%     0.3 ms
multilingual-MiniLM-L12   0.430          R@1 36.5%   miss 40.0%     0.5 ms
FTS + RRF fusion          0.822          R@1 73.5%   miss  3.0%   +480 ms
```

On Thai the gap is ~2.5× in lexical's favour (0.768 vs 0.308) — ICU word segmentation
is doing work no 384-dim multilingual model matched. And **RRF fusion made retrieval
worse**, 0.890 → 0.822: k=60 weights both lists equally, so blending a weak one into a
strong one drags the strong one down.

That set measures **known-item** retrieval, which is what lexical search is best at. The
paraphrase set — same pool, **same 200 target documents**, queries rewritten by a local
model told not to reuse the target's terms — is the other half, and **the ordering flips**:

```
                        known-item   paraphrase    delta
FTS (ICU)                    0.890        0.046   -0.844
multilingual-e5-small        0.600        0.140   -0.461
```

So the two methods fail in opposite regimes. What they do **not** do is fail on different
queries *within* a regime — which is the measurement that decides whether to build anything:

```
KNOWN-ITEM           e5 HIT  e5 MISS       PARAPHRASE     e5 HIT  e5 MISS
   FTS HIT             154       41          FTS HIT          18        5
   FTS MISS              1        4          FTS MISS        50      127
```

Asymmetric containment. e5 adds **1** query in 200 to FTS on known-item; FTS adds **5** to
e5 on paraphrase. Oracle bounds are +0.5% and +2.5% over the better single method, and RRF
lost at every k in **both** directions — so no fusion and no router. The prize is the
regime switch itself (paraphrase recall@20 **11.5% → 34%**), which no blend reaches.

`search` still does not read vectors, and that is now a measured decision rather than an
untested one: a `--semantic` mode is justified in principle — the user knows their query
style better than a classifier would — but not by quality. 0.140 MRR, 34% recall@20,
median target rank 68 of 3,000 is a different failure from FTS's, not a better one.
`relic embed` ships as the infrastructure that makes this measurable.

### `langs` — which languages, so which model

The default model, `all-minilm`, is English-only: Thai paraphrase MRR **0.006** in
bench/. Whether that matters is a fact about the corpus, so `langs` measures it on the
population `embed` would feed a model: the same tiers, the same `--min-chars`, the same
first `--max-chars` of each event.

```bash
relic langs                       # whole index, 1 event in 64
relic langs --repo neo-oracle     # one repo
relic langs --sample 1 --json     # every event, machine-readable
```

```
sample   1 in 64 by uid -> 4,238 events · ~271,232 eligible · 0.2 s

lang        events   share   chars   what it is
th              46    1.1%    2.0%   Thai is at least half the letters
th+en          191    4.5%    5.5%   Thai is 10-49% of the letters: code-switched, usually with English
en           2,093   49.4%   54.7%   Latin script with English function words: prose
latin        1,908   45.0%   37.8%   Latin script without them: code, paths, JSON, ids, or another Latin language
any Thai       467   11.0%           at least one Thai character (bench/'s definition)

role            events   carry Thai
note             1,609    21.8%
assistant          502     7.2%
user               243     3.3%

vectors  st:intfloat/multilingual-e5-small+passage: · 384d · 66,570 rows in 2 shards

model    MULTILINGUAL. 11.0% of eligible events carry Thai, at or above 1.0%. ...
         -> keep the model on disk (st:intfloat/multilingual-e5-small+passage:). ...
```

`--repo neo-oracle`, 2026-09-23, trimmed. How it decides:

| | |
|---|---|
| script, not a detector | Thai against Latin is a Unicode-block question and needs no model. Latin text is split by English function words, so `en` is prose and `latin` is code, JSON, paths and ids. Single letters do not count: `a` is the commonest function word in prose and the commonest variable name in code. |
| the sample | `uid < '0400'` is 1 in 64. Every shape mints uids with `uidOf`, a sha1, so a hex range is uniform and repeatable, and the filter runs inside Lance instead of reading text that would be thrown away. A test pins the premise on 64,000 real uids. |
| the rule | at least 1% of eligible events carrying Thai, or dominated by another non-Latin script, means multilingual. |
| the candidates | `MEASURED_MODELS` in `embed.ts`: only models measured here, with the evidence each one has. The Ollama en-th cosine and the bench/ MRR are never ranked against each other. |
| keep beats switch | when the vectors already on disk fit, the advice is to keep that model. embed refuses a second model per shard (`--reset` drops the vectors), and semantic search embeds a query with the model its shard stores. |

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

Nine tools, each one deterministic lookup with named parameters:

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
| `relic_trace` | the query log — what has been **asked** of this index (keyword cloud, zero-hit + FTS-miss counts, latency); the one that answers "what came back empty", right before a model improvises | — |

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

- **Narrowing is not cosmetic.** Measured on this index at 817 shards: unfiltered is
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

## What noise filtering drops (on by default since #37; `--keep-noise` opts out), and what it deliberately does not

Measured on a 285-file shard — **14% of stored text**:

| rule | rows | MB | what it is |
|---|---|---|---|
| `file-readback` | 810 | 2.64 | a file read into the transcript |
| `edit-payload` | 456 | 0.69 | an Edit/Write payload — the file now exists on disk |
| `binary-blob` | 55 | 0.20 | base64 images and similar (widened in #37 to any unbroken 120-char run — also catches hex, JWTs, minified JS) |
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
`claude-memory`. Built-in and **off**: `oracle-vault` and `oracle-vaults` (vault
locations are per-machine), `hermes`, and `omx-logs` (those `.jsonl` files are ops
logs, not conversation, and indexing them floods search with noise).

### Every oracle's vault, not one

`oracle-vault` names ONE path. `oracle-vaults` walks `<ghq>/github.com/<org>/<repo>/ψ`
and finds all of them — measured here: **413** ψ paths, **386** distinct after
resolving symlinks, **116,849** notes in 43 s.

```bash
relic index --corpus oracle-vaults
```

Four things it has to get right, each of which fails silently:

- **A symlinked ψ is invisible** to `readdir` — `isDirectory()` is false for a symlink,
  and the `/psi` skill deliberately points a plain repo's ψ at a caretaker oracle's
  vault. 77 of 413 do this. The entry point is resolved with one `realpath`.
- **Recursion must NOT follow symlinks.** `ψ/incubate/<org>/<repo>/origin` links back
  out into the ghq tree, so a walker that follows everything goes vault → repo →
  another vault. The same `isDirectory()===false` that causes the first problem
  prevents this one, so the fix is the entry point only.
- **A vault can contain another vault**, so dedup is by CONTAINMENT, not equality —
  111 of 116,952 files were emitted twice before that.
- **A worktree carries a copy of the vault.** `<repo>/wt/<slug>/ψ` and
  `<repo>/agents/<slug>/ψ` are real directories, not links back, so realpath cannot
  collapse them — and a repo commits its vault, so each is a near-complete copy of the
  main checkout's. Measured 2026-09-22: 109 of them, 96 distinct once resolved, holding
  **194,863** notes — of which **738** exist nowhere else. See the dedupe rule below.

### The rule that keeps a worktree vault from doubling the corpus

Two notes are the same note when they share **the owning repo, the path inside the
vault, and the byte size**. `repoKeyOf` collapses `<repo>/wt/<slug>` back to `<repo>`,
which is what lets the two copies meet; size is in the key because a shared path is not
a promise of shared content — of the 12,820 notes that exist at one path in two
checkouts, 12,677 are byte-identical and **143 hold a worktree edit that never came
back**.

The repo-level vault is walked FIRST and wins every tie. That order is the rule, and it
is not taste: `relic prune` deletes rows whose file discovery no longer yields, so a
rule that demoted an already-indexed path would queue it for deletion.

Both full runs below are real, not extrapolated — `--data-root` into a throwaway
directory, so the live index was never touched.

| walk | files discovered | events indexed | shards | run |
|---|---|---|---|---|
| repo-level ψ only (before) | 147,901 | 155,514 | 310 | 52.2 s |
| + worktree vaults, no dedupe | 342,764 (**+131.8%**) | — | — | — |
| + worktree vaults, deduped | 148,639 (**+0.50%**) | 156,529 | 312 | 61.6 s |

The 738 notes that survive are 582 at a path the main checkout does not have and 156 at
a shared path with different bytes. The two extra shards are repos whose only vault
content lives in a worktree.

---

## `tier` and `kind` are two axes

`tier` is a POSITION in a transcript hierarchy — `session`, `subagent`,
`workflow_agent`. `kind` is WHAT a row is — `transcript`, `note`, `memory`,
`message`.

They used to be one column, so the default filter `(tier = 'session' OR tier = 'note')`
read as "the main tiers" and actually meant "one tier plus one kind". That cost
something real once: a tier default of `"session"` made 10,000 freshly indexed vault
notes invisible while the result count looked perfectly healthy.

`kind` is added by the lazy `widen()` migration, so **shards written before it have no
such column at all** — not an empty one. A filter that merely guards with `kind = ''`
still *names* the column, which is invalid SQL there: every shard throws, the
per-shard catch swallows it, and search returns zero matches while reporting a healthy
shard count. The read path checks the schema and picks its filter before building any
SQL.

## Data model

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  relic — data model and its joins                        measured 2026-09-18 ║
║  3 tables + 1 optional · 0 FKs · file_path is the real key, session_uuid not ║
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
                            text_idx(text)          ICU · stem:false · stop words kept · maxToken 128
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
    No full text of a file that exists on disk (noise filtering drops readbacks; --keep-noise restores them).
    No vectors, unless `relic embed` was run. They go to a 4th table,
    `vectors` (uid PK -> FixedSizeList<Float32,dim>), NEVER a column on
    `events`: a vector column cannot be added by widening, and in the
    TypeScript client it lands as Utf8 and stores "0.1,0.2,..." as TEXT
    with no error. `index` never writes it; embedding is a second pass.
    The index is a POINTER: (file_path, seq) -> `show` re-reads the source .jsonl.

 SIDECARS   ~/.relic/trace.jsonl    one line per query, + `opened` on show
            ~/.relic/skipped.jsonl  one line per dropped event, with the rule
                                    — and per unreadable path (`relic skipped --files`)
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

So is `removeStopWords: false`. LanceDB removes stop words by default, and under ICU the
list is not English but 21 languages at once: 5,200 words, `nas`, `bin`, `min`, `var`
and `del` among them. `relic search nas` answered 0 on an index where a rebuild without
the filter finds 9,971 rows (#97). An index keeps the settings it was built with, so
after a change like this run `relic index --fts-rebuild` once per machine. It rebuilds
every shard on disk, including the ones a normal run never reaches: 1,136 shards in
128 s here.

---

## Performance

Measured 2026-09-18 at **817 shards / 3,394,951 events / 167,853 sessions**, index
3.2 GB over ~34 GB of raw transcripts plus 116,849 vault notes:

| command | latency | shards read |
|---|---|---|
| `search --repo <one>` | ~200 ms | 1 |
| `search --bank projects-archive` | **90 ms** | 162 |
| `search` (unfiltered) | **356 ms** | 508 |
| `status` (with both clocks) | **1.42 s** | 508 |
| `pending` (whole corpus) | **2.0 s** | 49,651 files scanned |
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
- **Embeddings in the default path.** `relic embed` exists and writes a real `vectors`
  table, but nothing calls it for you and search does not read it yet. On this corpus
  keyword retrieval measured far ahead of every model tried (0.890 MRR@20 against
  0.600), so keyword is what ships. See *Embeddings, measured* below.

## License

MIT
