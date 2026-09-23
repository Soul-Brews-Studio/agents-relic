import { defaultRoot } from "./repo.js";

/**
 * The `--help` text, as its OWN module.
 *
 * It lived inside cli.ts, which runs a command at import time — so nothing could
 * import it, so no test ever parsed it, so a stray backtick took the whole CLI down
 * and only a human running `relic` found out. That happened FOUR times in one week:
 *
 *     error: Expected ")" but found "vaults"
 *     error: Expected ")" but found "sessions"
 *
 * Both from writing `vaults` or `sessions` in backticks inside a template literal,
 * where a backtick ends the string. Here the module is importable, so test/help.test.ts
 * fails the moment the file stops parsing — before anyone ships it.
 */
export function helpText(): string {
  return `relic — per-repo LanceDB index of Claude Code + Codex session JSONL

  index   [--corpus ...] [--since 7d] [--repo SUBSTR] [--keep-noise] [--dry-run] [--prune]
          [--fts-rebuild]      rebuild the full-text index of EVERY shard on disk, every
                               bank, and import nothing. Once per machine after an FTS
                               setting changes: an index keeps the settings it was built
                               with, and a run only reaches the shards it discovers.
          [--source-path PATH]   run ONE --corpus against a root it does not normally
                               walk — same walker, parser and bank. For a vault
                               outside the ghq tree the vaults walker enumerates.
  prune   [--apply] [--corpus ...] [--max-drop 10] [--force]
                               remove index rows for files discovery no longer yields.
                               DRY BY DEFAULT — --apply is the only thing that deletes.
                               Refuses --since/--repo (a narrowed scan makes everything
                               outside it look deleted), refuses a run with parse
                               failures, skips shards this run never reached, and
                               REFUSES any shard losing more than --max-drop percent.
  search  <query> [--repo S] [--bank B] [--org S] [--project S] [--dir S] [--all-tiers] [--worktree S] [--path S] [--tier ...] [--source ...]
                  BM25 FINDS TOPICS, NOT SPECIFIC FACTS. For "did I already do X",
                  search the most UNIQUE literal string in the request — an id, a
                  filename, an error string — not the topic words. Measured on 288
                  real queries here: longer queries return 11x MORE hits than short
                  ones (median 1,392 vs 123), because FTS ranks any document holding
                  any term, so every extra word widens the candidate set.
                    95,529 hits  "herdr pane run agent prompt recent-unwrapped"
                         1 hit   "VoiceProcessingEnabled"
                  [--since 7d|2026-09-01] [--until DATE] [--limit N]
                  [--prose]  humans + assistant only — 80% of a transcript is tool traffic
                  [--role user|assistant|tool_use|tool_result|thinking]
                  [--semantic] nearest-neighbour over relic-embed vectors instead of
                  BM25. A separate MODE, never blended: measured here, FTS wins
                  known-item 0.890 vs 0.600 and loses paraphrase 0.046 vs 0.140.
                  [--overfetch 4] [--device mps]
                  [--no-warn]  suppress the generic-query warning: fires when EVERY
                  term you typed is common across the scoped corpus, meaning no term
                  can anchor a search — never blocks the search or changes ranking.
  show    <file> --seq N [--before 2] [--after 2]
  session <id|prefix> [--repo S] [--bank B] [--tree]  resolve an id to its transcripts
                               --tree shows the SHAPE: which agents shared a workflow run
  chain   <id|prefix>          the session tree on one time axis — what ran in parallel
  lineage [id|prefix] [--all]  which session ids are ONE line of work: /clear and a
                               relaunch start a new id, /compact keeps it. Linked from
                               the transcripts (SessionStart hook, the /clear turn, the
                               old file's final write), never the index. NO ID = this
                               session. --all draws every chain in the directory.
                               A Hermes id links by state.db rows instead: a shared
                               session_key is one line, a parent_session_id spawn is
                               drawn as that parent's agents, never as continuation.
  read    <file> [--prose]     whole transcript as readable conversation, any format
  tail    [id|prefix|file] [-n 10] [--chars N] [--role user] [--flat] [--harness]
          [--handoff]          the block to paste as the next session's FIRST prompt:
                               your turns in full, mine trimmed to half under them — "go"
                               means nothing without the proposal it answered. Time on the
                               first and last line ONLY, plus the span/median-gap/longest-gap
                               that say whether this was one hard-focused hour or a day of
                               parallel work. Add --role user for your turns alone.
                               NO ARGUMENT = the session before this one, here —
                               so a /new session can read back without being told
                               an id. Found by mtime, never the index. Hermes
                               sessions that ran in this checkout count too.
                               the LAST N EXCHANGES — what was I just doing. An
                               exchange is the human's turn plus the last thing
                               the agent said before they spoke again. Takes a
                               session ID, reads the FILE not the index (so it is
                               never stale), and strips harness turns by default:
                               55 of 63 user-channel turns were the tooling itself.
  mcp                          run the MCP server on stdio (same lookups, for a model)
  now|live [--all] [--window 300]  what is running RIGHT NOW — this session, its agents
                               --all is machine-wide, Hermes sessions (state.db) included
  dig [N] [--deep] [--no-cache] session timeline as JSON — dig.py contract, all 3 tiers
  sessions [--repo S] [--bank B] [--since 24h] [--worktree S] [--count] [--limit 40]
  report  [--since 7d] [--repo S] [--bank B] [--worktree S] [--tree] [--per-repo 4]
          [--all-tiers]        day by day: which repo, which worktree, what it was
                               called. --tree adds each session's transcript shape.
                               Transcript tiers only — a sessions row can be a ψ note,
                               which outnumber conversations 100:1. --all-tiers counts
                               them too.
  memory  [--mem-type T] [--bank B] [--limit 20]  Claude's own memory, joined to the
                               sessions that produced it — which had one, which had none
  pending [--corpus ...] [--since 1h] [--repo S] [--bank B] [--list N] [--paths]
                               on disk but not indexed: missing vs changed. --list N
                               names them — session id, repo, bank, newest first.
                               --paths adds the full session id and absolute path.
                               --tree groups them by directory — which RUN is missing.
  embed   [--model all-minilm] [--provider ollama|st] [--host URL] [--device mps] [--repo S] [--bank B]
                               [--limit N] [--batch 64] [--all-tiers] [--min-chars 24] [--max-chars 2000]
                               [--dry-run] [--reset] [--force]
                               [--session ID]  embed ONE session — the /forward + /new unit
                               --model all-minilm, the default, is ENGLISH-ONLY: all-MiniLM
                               scored 0.006 on Thai paraphrase (bench/). For Thai: --model
                               bge-m3, or --provider st --model intfloat/multilingual-e5-small.
                               Before any provider call, embed samples the scope's languages
                               as langs does, and REFUSES an English-only model when 1% or
                               more of the events carry Thai, or another non-Latin script.
                               --force embeds anyway; --dry-run shows the same check.
                               second pass, opt-in: writes a per-shard \`vectors\` table,
                               never a column on \`events\`. Resumable — re-run to continue.
                               Measured first: FTS beats every model tried here (bench/).
  langs   [--sample 64] [--repo S] [--bank B] [--all-tiers] [--min-chars 24] [--max-chars 2000] [--json]
                               which languages the embeddable corpus is written in, and
                               which measured model fits it: th / th+en / en / latin /
                               other scripts, share of events and chars, Thai by role,
                               vectors already on disk. Same population as embed.
                               1 in 64 events by default, picked by uid (a sha1, so the
                               sample is uniform and repeatable); --sample 1 reads all.
  recap   [id|prefix] [--limit 20] [--all-tiers] [--chars 140] [--json]
                               NO ID = the session before this one, same as tail.
                               Shows the LAST 20 asked turns; --limit 0 for all. The
                               footer prints the command to widen it, so a model
                               reading a truncated recap can fetch the rest itself.
                               what HAPPENED in one session — the human's turns with
                               harness boilerplate stripped, the tools that ran, files
                               edited, and how it ended. A projection of indexed rows,
                               not a summary: session gives shape, recap gives content.
  status  [--limit 15] [--bank B]
  sources                      what this machine has, and what is on/off
  skipped [--files] [--json]   what noise filtering dropped, and the proof (--keep-noise disables it)
                               --files: paths the walk could NOT READ, so nothing in them was
                               indexed — one row per path, newest first. Index runs log them.
  serve   [--host 127.0.0.1] [--port 4319] [--token T] [--origin URL,URL]
                               the MCP tools over HTTP at /mcp, for clients that are not
                               a child process — a browser UI, another machine, another
                               oracle. --host 0.0.0.0 binds EVERY interface (loopback,
                               LAN and mesh at once) and REFUSES to start without a
                               token: this serves the whole machine's session history.
                               RELIC_TOKEN works too, and keeps it out of the ps table.
  probe   [--corpus claude-live] [--repo S] [--files 40] [--samples 3] [--json]
                               what the noise rules WOULD drop, with samples of each
                               rule's catches. Writes nothing. Run this after touching
                               noise.ts — a rule that eats content still passes its
                               unit tests; only real transcripts show it.
  trace   [--limit 10] [--cloud]  query log: who answers, what is dead, keyword cloud
  backend [--probe]            which engine answers what, and how fast here
  banks                        bank names on this machine
  shards  [--bank B] [--repo S] [--count]   the index layout

  --no-native        force the TypeScript scan (see: relic backend)
  --native PATH      use a specific relic-native binary
  --in-repo          write <ghq>/<org>/<repo>/.relic/ instead of ~/.relic
  --data-root PATH   explicit index location
  --json --jsonl --plain   machine output (or --format json|jsonl|plain)
                     plain = file<TAB>seq<TAB>repo<TAB>text, one per line

Sharded BANK first, then per repo ghq-style, under $HOME by default:
  ${defaultRoot()}/banks/<bank>/github.com/<org>/<repo>/

A bank is one whole source root (a Claude projects dir, codex, omp, memory).
--bank filters to one exactly; relic status prints the banks on this machine.

LanceDB only, with an ICU full-text index: real Thai word segmentation, and
2-character queries work (trigram cannot do either). Vectors live in a SEPARATE
per-shard \`vectors\` table, written only by \`relic embed\` — never as a column on
\`events\`, which cannot be widened to a vector type without silently storing it
as text. See relic embed --dry-run before spending anything.`;
}
