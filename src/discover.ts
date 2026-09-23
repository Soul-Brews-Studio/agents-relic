import { readdirSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { bankOf, loadSources } from "./sources.js";
import { repoKeyOf } from "./repo.js";
import { hermesSessions } from "./shapes/hermes.js";
import type { Parser } from "./types.js";

// "note" is not a transcript tier — a vault document has no turns. It shares the
// enum so the whole query surface (search/show/sessions/MCP) stays one code path.
export type Tier = "session" | "subagent" | "workflow_agent" | "note" | "memory";

/**
 * The OTHER axis: what a row is, as opposed to where it sits.
 *
 * `note` and `memory` were never tiers — a document has no position in a transcript
 * hierarchy. Keeping both axes in one column made the default search filter
 * `(tier = 'session' OR tier = 'note')`, which reads as "the main tiers" and is really
 * "one tier plus one kind"; a tier default of "session" once hid 10,000 freshly
 * indexed vault notes while the result count looked perfectly healthy.
 */
export type Kind = "transcript" | "note" | "memory" | "message";

/**
 * Derived, never stored twice.
 *
 * `source` decides before `tier` does, because hermes rows carry tier "session" while
 * being chat messages rather than an agent transcript — tier alone cannot tell them
 * apart, and reading tier first would file every hermes message as a transcript.
 */
export function kindOf(tier: Tier | string, source: string): Kind {
  if (source.startsWith("hermes")) return "message";
  if (tier === "note") return "note";
  if (tier === "memory") return "memory";
  return "transcript";
}

export interface Found {
  path: string;
  projectDir: string;      // raw encoded dir name (display only — the encoding is lossy)
  tier: Tier;
  source: string;
  bank: string;            // top level of the shard path — see bankOf in sources.ts
  workflowRunId: string | null;
  agentId: string | null;
  mtime: number;
  size: number;
  parser: Parser;
}

const HOME = homedir();

// Sources come from the registry in sources.ts (config-overridable), not from a
// hardcoded list here — adding an agent should not require editing the walker.

function statOf(p: string) {
  try { const s = statSync(p); return { mtime: Math.floor(s.mtimeMs / 1000), size: s.size }; }
  catch { return null; }
}

function dirs(p: string): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
}

function files(p: string, ext = ".jsonl"): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(ext)).map(e => e.name); }
  catch { return []; }
}

/**
 * Walk a Claude projects root. THREE tiers, and the third is the one that gets missed:
 *
 *   <root>/<project>/<uuid>.jsonl                                        session
 *   <root>/<project>/<uuid>/subagents/<agent>.jsonl                      subagent
 *   <root>/<project>/<uuid>/subagents/workflows/wf_<run>/agent-<id>.jsonl       workflow_agent
 *
 * The workflow tier sits one directory deeper than an obvious glob reaches, which is
 * exactly the bug in /dig --deep: it silently drops ~73% of the corpus by file count.
 * Measured on this machine: 7,327 session / 7,801 subagent / 21,305 workflow_agent.
 */
/** One `subagents/` directory: its agent transcripts, and the workflow tier beneath it. */
function walkSubagents(subagents: string, project: string, sinceMs: number | null,
                       out: Found[], srcKey: string, parser: Parser) {
  if (!existsSync(subagents)) return;
  for (const f of files(subagents)) {
    const p = join(subagents, f);
    const st = statOf(p);
    if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
    out.push({ path: p, projectDir: project, tier: "subagent", source: srcKey,
      workflowRunId: null, agentId: basename(f, ".jsonl"), ...st, parser });
  }

  // --- the tier everyone forgets ------------------------------------------
  const workflows = join(subagents, "workflows");
  if (!existsSync(workflows)) return;
  for (const run of dirs(workflows)) {
    if (!run.startsWith("wf_")) continue;
    for (const f of files(join(workflows, run))) {
      // journal.jsonl is the RUNNER's event log — launched/started/result records
      // describing the workflow, not a transcript of anything an agent said. It sits
      // in the same directory as the agent transcripts, so taking every .jsonl
      // indexed runner metadata as if it were conversation: searchable text with a
      // role and a session id attached, and no cwd, so it landed in `_unresolved`.
      // Same reason walkMemory skips MEMORY.md.
      if (f === "journal.jsonl") continue;
      const p = join(workflows, run, f);
      const st = statOf(p);
      if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
      out.push({ path: p, projectDir: project, tier: "workflow_agent", source: srcKey,
        workflowRunId: run, agentId: basename(f, ".jsonl"), ...st, parser });
    }
  }
}

function walkClaude(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  for (const project of dirs(root)) {
    const projectPath = join(root, project);

    for (const f of files(projectPath)) {
      const p = join(projectPath, f);
      const st = statOf(p);
      if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
      out.push({ path: p, projectDir: project, tier: "session", source: srcKey,
        workflowRunId: null, agentId: null, ...st, parser });
    }

    /*
     * A `subagents/` DIRECTLY under the project dir, with no session-uuid directory
     * between. Found on 2026-09-19 while indexing a second account's corpus: 14 real
     * subagent transcripts across two roots that no relic run had ever seen, because
     * the walk below only ever looks one level deeper.
     *
     * `subagents` is itself returned by dirs(projectPath), so the loop below treats it
     * as a session dir and looks for `<project>/subagents/subagents` — which does not
     * exist, so it is skipped in silence rather than reported. Discovery that misses a
     * shape reports success with a smaller number, and the number looks fine.
     *
     * Same walker as the per-session case, called with a different base, so the two
     * cannot drift about what a subagent directory contains.
     */
    walkSubagents(join(projectPath, "subagents"), project, sinceMs, out, srcKey, parser);

    for (const sessionDir of dirs(projectPath)) {
      if (sessionDir === "subagents") continue;   // handled above, do not walk twice
      const subagents = join(projectPath, sessionDir, "subagents");
      if (!existsSync(subagents)) continue;

      walkSubagents(subagents, project, sinceMs, out, srcKey, parser);
    }
  }
}

/** Codex rollouts nest by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
function walkFlat(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser, depth = 0) {
  for (const f of files(root)) {
    const p = join(root, f);
    const st = statOf(p);
    if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
    out.push({ path: p, projectDir: srcKey, tier: "session", source: srcKey,
      workflowRunId: null, agentId: null, ...st, parser });
  }
  if (depth >= 4) return;   // date nesting is 3 deep; 4 is slack, not a full-tree sweep
  for (const d of dirs(root)) walkFlat(join(root, d), sinceMs, out, srcKey, parser, depth + 1);
}

/**
 * omp: ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 *
 * One directory per cwd, flat .jsonl files inside — plus a same-named EXTENSIONLESS
 * directory beside each transcript holding that session's bash output logs
 * (`16.bash.log`). `files()` filters on the .jsonl extension, so those are skipped
 * without needing a rule.
 *
 * Deliberately not `walkFlat`: that sets projectDir to the source key and throws the
 * per-cwd directory away, which is the one thing `currentSession` needs to resolve
 * "which session am I in" without parsing every file.
 */
function walkOmp(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  for (const project of dirs(root)) {
    const projectPath = join(root, project);
    for (const f of files(projectPath)) {
      const p = join(projectPath, f);
      const st = statOf(p);
      if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
      out.push({ path: p, projectDir: project, tier: "session", source: srcKey,
        workflowRunId: null, agentId: null, ...st, parser });
    }
  }
}

/**
 * Two hooks, at two points, because they answer two different questions.
 *
 * `keep` is the DEDUPE veto: it sees every note the walk reaches and says whether this
 * copy of it is worth a row. `found` is the progress tick and fires only for notes that
 * actually landed, so the number it reports stays a count of results.
 */
interface VaultHooks {
  keep?: (file: string, size: number) => boolean;
  found?: () => void;
}

/**
 * Oracle vault: `<repo>/ψ/**.md`.
 *
 * Bounded by extension and by an explicit skip list, NOT by depth — the vault nests
 * arbitrarily (`ψ/memory/retrospectives/2026-09/18/…`) so a depth cap would silently
 * drop the deepest and most recent notes. `node_modules` and `.git` are skipped
 * because lab subprojects inside the vault carry both, and vendored markdown is
 * 280 files of other people's READMEs, not vault content.
 */
function walkVault(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser, depth = 0, hooks: VaultHooks = {}) {
  if (depth > 12) return;                     // pathological-symlink guard, not a scope limit
  for (const f of files(root, ".md")) {
    const p = join(root, f);
    const st = statOf(p);
    if (!st) continue;
    /*
     * The veto runs BEFORE `--since`, deliberately.
     *
     * A worktree is a fresh checkout, so git stamps every note in it with the moment
     * the worktree was cut. Under `--since 7d` the COPIES look new and the ORIGINALS
     * look old — the exact inversion that would make a narrowed run index the
     * duplicates it is supposed to suppress. The veto has to see the whole vault
     * before it can say "already have this one".
     */
    if (hooks.keep && !hooks.keep(p, st.size)) continue;
    if (sinceMs && st.mtime * 1000 < sinceMs) continue;
    out.push({ path: p, projectDir: srcKey, tier: "note", source: srcKey,
      workflowRunId: null, agentId: null, ...st, parser });
    hooks.found?.();
  }
  for (const d of dirs(root)) {
    if (d === "node_modules" || d === ".git") continue;
    walkVault(join(root, d), sinceMs, out, srcKey, parser, depth + 1, hooks);
  }
}

const PSI = "\u03c8";

/** `<org>/<repo>/ψ` — the vault a repo keeps in its main checkout. */
function repoVaultPaths(root: string): string[] {
  const out: string[] = [];
  for (const org of dirs(root)) {
    const orgPath = join(root, org);
    for (const repo of dirs(orgPath)) out.push(join(orgPath, repo, PSI));
  }
  return out;
}

/**
 * The SAME repo, checked out again: `<repo>/wt/<slug>/ψ` and `<repo>/agents/<slug>/ψ`.
 *
 * TWO NAMES, not "whatever is at that level". `contextOf` in repo.ts already reads
 * exactly these two as a worktree segment, and the level itself is not safe to take —
 * measured on this machine 2026-09-22, every directory at `<repo>/<X>/<slug>/ψ`:
 *
 *   60  wt/<slug>/ψ
 *   49  agents/<slug>/ψ
 *   14  one-offs — an incubated subproject's own checkout, a nested app
 *
 * Those 14 are OTHER repos that happen to live inside this one. Walking the level
 * would file their notes under the containing repo's key, which is the wrong answer
 * stored permanently rather than a missing one that can still be found.
 */
const WORKTREE_DIRS = ["wt", "agents"];

function worktreeVaultPaths(root: string): string[] {
  const out: string[] = [];
  for (const org of dirs(root)) {
    const orgPath = join(root, org);
    for (const repo of dirs(orgPath)) {
      for (const wt of WORKTREE_DIRS) {
        const wtPath = join(orgPath, repo, wt);
        for (const slug of dirs(wtPath)) out.push(join(wtPath, slug, PSI));
      }
    }
  }
  return out;
}

/**
 * Candidate paths -> the directories they actually name.
 *
 * lstat first: existsSync FOLLOWS the link, so a dead one is already false — but a
 * live one must be resolved before `dirs()` refuses to see it. 40 of this machine's
 * 421 repo-level ψ point at a path that does not exist here, and they drop out here.
 */
function resolveVaults(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    try { lstatSync(p); out.push(realpathSync(p)); }
    catch { /* missing, or a dead symlink — contributes nothing */ }
  }
  return out;
}

/*
 * A VAULT CAN CONTAIN ANOTHER VAULT, and equality-dedup does not catch it.
 *
 * `ψ/incubate/<org>/<repo>/origin` is a real checkout living inside a vault, and
 * that checkout has its own ψ. Both are enumerated: the outer one emits the inner
 * one's notes while recursing, and then the inner one is walked again on its own.
 * Measured before this: 111 files emitted twice out of 116,952.
 *
 * Sorting by length puts every container ahead of anything it contains, so one
 * forward pass decides it. The trailing separator matters — without it, a sibling
 * named `ψ-old` would be treated as living inside `ψ`.
 *
 * `already` carries the roots an earlier pass kept, so the worktree pass is judged
 * against the repo-level vaults as well as against itself.
 */
function outermost(cands: string[], already: string[] = []): string[] {
  const kept = [...already];
  const fresh: string[] = [];
  for (const real of [...cands].sort((a, b) => a.length - b.length)) {
    if (kept.some(k => real === k || real.startsWith(k + "/"))) continue;
    kept.push(real);
    fresh.push(real);
  }
  return fresh;
}

/**
 * WHAT MAKES TWO FILES THE SAME NOTE — the rule this whole walk turns on.
 *
 * The owning repo, the note's path INSIDE its vault, and its byte size. A worktree
 * vault is a second checkout of one repo, so the note at `ψ/memory/x.md` in the
 * worktree is the note at `ψ/memory/x.md` in the main checkout; the absolute paths
 * differ and nothing else does.
 *
 * `repoKeyOf` collapses `<repo>/wt/<slug>` back to `<repo>`, which is what lets the
 * two sides meet. Its fallback is the vault root itself — a vault outside a
 * `github.com/<org>/<repo>` path has no twin to collide with, so it keeps everything.
 *
 * SIZE IS IN THE KEY because a shared path is not a promise of shared content:
 * measured over the 12,820 notes that exist at one path in two checkouts, 12,677 are
 * byte-identical and 143 are not — a worktree holding an edit that never came back.
 * Hashing every byte would settle those 143 exactly and cost a full read of 194,863
 * files that discovery currently only stats; size settles 143 of 143 for free, because
 * `statOf` has already read it. It is the cheap key that happens to be the right one
 * HERE, where the two copies come from the same commit or from an edit to it.
 */
function noteKey(vault: string, file: string, size: number): string {
  return `${repoKeyOf(vault) ?? vault}\u0000${file.slice(vault.length + 1)}\u0000${size}`;
}

/**
 * EVERY oracle's vault, not one.
 *
 * `walkVault` takes a single root, which indexes one oracle and leaves the rest dark.
 * Measured on this machine: 413 repos carry a ψ, and exactly one of them was indexed.
 *
 * Four things have to be right here, and each fails SILENTLY if it is not:
 *
 * 1. RESOLVE THE ENTRY POINT. `dirs()` filters on `e.isDirectory()`, which is FALSE
 *    for a symlink — `isSymbolicLink()` is true instead. The /psi skill deliberately
 *    points a plain repo's ψ at a caretaker oracle's vault, and 77 of the 413 use it,
 *    including this repo's own. Without an explicit resolve they are not "empty",
 *    they are invisible.
 *
 * 2. DO NOT follow symlinks once INSIDE a vault. `ψ/incubate/<org>/<repo>/origin`
 *    links back out into the ghq tree, so a walker that follows everything can walk
 *    from one vault into a repo and back into another vault. walkVault already
 *    behaves correctly here precisely BECAUSE isDirectory() is false for symlinks —
 *    the same fact that causes problem 1 prevents problem 2. Resolve at the top only.
 *
 * 3. DEDUPE BY REALPATH. 413 paths resolve to 386 targets; walking paths instead of
 *    targets indexes a shared vault once per repo that points at it.
 *
 * 4. SKIP DEAD LINKS. Several point at /Users/nat/Code/..., which does not exist on
 *    this machine. existsSync on a broken symlink is false, so this falls out of the
 *    resolve — but only if the resolve is attempted at all.
 *
 * 5. WORKTREE VAULTS EXIST, AND THEY ARE MOSTLY COPIES. This used to read "worktrees
 *    need no special case — they live one level below what this enumerates", and that
 *    sentence hid 109 of them. They are real directories, not links back, so realpath
 *    cannot collapse them; a repo commits its vault, so every worktree carries a
 *    near-complete copy of it. Measured on this machine 2026-09-22:
 *
 *      109  ψ under wt/ and agents/ — 96 distinct once resolved, since 4 link into
 *           another repo's worktree and 9 are already reached through some repo's
 *           root ψ symlink
 *
 *      147,901  files the repo-level walk yields today
 *      342,764  what a wider walk with no rule yields          +131.8%
 *      148,639  what this yields                               +  0.50%
 *
 *    So the walk widens and `noteKey` decides. The two passes are ordered, and the
 *    order IS the rule: the repo-level vault goes first and wins every tie, so nothing
 *    discovered before this change is discovered any less. That matters beyond taste —
 *    `relic prune` deletes rows whose file discovery no longer reaches, so a rule that
 *    demoted an already-indexed path would queue it for deletion.
 */
export function walkVaults(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  // Resolve every candidate FIRST, then walk. Two passes because the dedup below is
  // containment, not equality, and containment needs the full set before it can
  // decide — which is only knowable once everything is resolved.
  const repos = outermost(resolveVaults(repoVaultPaths(root)));
  const seen = new Set<string>();
  for (const vault of repos) {
    walkVault(vault, sinceMs, out, srcKey, parser, 0, {
      keep: (p, size) => { seen.add(noteKey(vault, p, size)); return true; },
    });
  }

  /*
   * Sorted, because "first one wins" is only a rule if the order is fixed. Two
   * worktrees of one repo can both hold a note the main checkout does not, and
   * whichever is walked first is the copy that gets the row — by path, every run.
   */
  const worktrees = outermost(resolveVaults(worktreeVaultPaths(root)), repos).sort();
  for (const vault of worktrees) {
    walkVault(vault, sinceMs, out, srcKey, parser, 0, {
      keep: (p, size) => {
        const k = noteKey(vault, p, size);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      },
    });
  }
}

/**
 * Progress for the DISCOVERY phase.
 *
 * Import had progress; discovery had none — and discovery is the part that walks the
 * whole tree before a single file is read. On a 10k-file source that silent window is
 * most of the wall time and is indistinguishable from a hang.
 *
 * Newline-delimited when stderr is not a TTY: the import progress uses `\r` to
 * overwrite one line, which renders live in a terminal but emits NOTHING visible
 * through a pipe or into a CI log until the process exits.
 */
function progressLine(msg: string): void {
  if (!process.stderr.isTTY) { process.stderr.write(msg + "\n"); return; }
  process.stderr.write("\r" + msg.padEnd(72) + "\r");
}

/**
 * Hermes: SQLite DBs, one per profile, MANY sessions each.
 *
 * Emits one Found per SESSION with a synthetic `<db>#<session_id>` path, because the
 * Parser contract is one file -> one session and a DB holds many. That keeps the
 * manifest, uids and `show` working unchanged instead of special-casing a DB source
 * through the whole pipeline.
 *
 * mtime is the session's own last_activity_at, NOT the file's: a live SQLite file's
 * mtime changes constantly while its rows mostly do not, so keying on the file would
 * re-import every session on every run.
 */
/** Every Hermes state.db under a root — one per profile, at most 3 levels down. */
export function hermesDbs(root: string): string[] {
  const dbs: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const f of files(dir, ".db")) if (f === "state.db") dbs.push(join(dir, f));
    for (const d of dirs(dir)) scan(join(dir, d), depth + 1);
  };
  scan(root, 0);
  return dbs;
}

function walkHermes(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  for (const db of hermesDbs(root)) {
    for (const s of hermesSessions(db)) {
      if (sinceMs && s.mtime * 1000 < sinceMs) continue;
      out.push({
        path: `${db}#${s.id}`, projectDir: srcKey, tier: "session", source: srcKey,
        workflowRunId: null, agentId: null,
        mtime: s.mtime,
        // Row count stands in for size: it changes exactly when the session gains a
        // message, which is what the manifest needs to detect.
        size: s.rows,
        parser,
      });
    }
  }
}

/**
 * Claude Code memory: `<root>/<encoded-project>/memory/*.md`.
 *
 * MEMORY.md is skipped — it is a one-line index OF the other files, so indexing it
 * repeats every memory's description as a second, lower-quality hit.
 */
function walkMemory(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  for (const project of dirs(root)) {
    const dir = join(root, project, "memory");
    if (!existsSync(dir)) continue;
    for (const f of files(dir, ".md")) {
      if (f === "MEMORY.md") continue;
      const p = join(dir, f);
      const st = statOf(p);
      if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
      out.push({ path: p, projectDir: project, tier: "memory", source: srcKey,
        workflowRunId: null, agentId: null, ...st, parser });
    }
  }
}

/**
 * `--source-path`: run one source against a path it does not normally walk.
 *
 * `sources.ts` has documented this flag since the oracle-vault entry was written and
 * it did not exist — the comment told you to run a command that fails. It exists now
 * because a real vault needed it: 55 worktree vaults (`<repo>/wt/<slug>/ψ`) across 17
 * repos are real directories the `vaults` walker never descends into, and 227 of one
 * such vault's notes had index rows with no way to rebuild them.
 *
 * Deliberately NOT a way to widen a walk. It overrides ONE source's root for ONE run,
 * so the walker, parser and bank are unchanged — which is what makes the result land
 * where the rest of that source's rows already live.
 */
export interface PathOverride { key: string; path: string }

/**
 * Every `projects*` root inside ONE agent home, under one source and one bank.
 *
 * The builtins name three roots inside ~/.claude by hand — and that is how
 * `projects-1sep-tue2026` went missing once already: it lived only in a sources.json
 * that got deleted, so a rebuild indexed two of three roots and reported success.
 * Enumerating the home removes the hand-maintained list, and a new snapshot directory
 * is picked up without a code change.
 *
 * `projects` FIRST when present, so the live root is scanned before any snapshot and a
 * killed run has the most useful half.
 */
export function walkClaudeHome(home: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  const roots = dirs(home).filter(d => d === "projects" || d.startsWith("projects-"));
  roots.sort((a, b) => (a === "projects" ? -1 : b === "projects" ? 1 : a.localeCompare(b)));
  for (const r of roots) walkClaude(join(home, r), sinceMs, out, srcKey, parser);
}

export function discover(only: string[] | null, sinceMs: number | null,
                         pathOverride: PathOverride | null = null): Found[] {
  const out: Found[] = [];
  const tick = () => {
    if (out.length && out.length % 2000 === 0) progressLine(`  scanning… ${out.length.toLocaleString()} files found`);
  };
  for (const src of loadSources()) {
    const wanted = only ? only.includes(src.key) : src.enabled;
    const root = pathOverride && pathOverride.key === src.key ? pathOverride.path : src.path;
    if (!wanted || !existsSync(root)) continue;
    progressLine(`  scanning ${src.key}…`);
    const before = out.length;
    if (src.walk === "claude-home") walkClaudeHome(root, sinceMs, out, src.key, src.parser);
    else if (src.walk === "memory") walkMemory(root, sinceMs, out, src.key, src.parser);
    else if (src.walk === "hermes") walkHermes(root, sinceMs, out, src.key, src.parser);
    else if (src.walk === "vaults") walkVaults(root, sinceMs, out, src.key, src.parser);
    else if (src.walk === "vault") walkVault(root, sinceMs, out, src.key, src.parser, 0, { found: tick });
    else if (src.walk === "omp") walkOmp(root, sinceMs, out, src.key, src.parser);
    else if (src.walk === "flat") walkFlat(root, sinceMs, out, src.key, src.parser);
    else walkClaude(root, sinceMs, out, src.key, src.parser);
    // Stamp the bank on what this source just contributed, rather than threading it
    // through all six walkers. A file's bank is a property of the SOURCE it was found
    // under, so the walkers never need to know about it.
    const bank = bankOf(src);
    for (let i = before; i < out.length; i++) out[i].bank = bank;
  }
  if (out.length >= 2000) progressLine(`  scanned ${out.length.toLocaleString()} files`);
  return out;
}

export function sourceKeys(): string[] { return loadSources().map(s => s.key); }

/** "7d" | "30m" | "12h" | "2026-09-01" -> epoch ms, or null. */
export function parseSince(s: string | undefined): number | null {
  if (!s) return null;
  const m = /^(\d+)([mhd])$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const mult = m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000;
    return Date.now() - n * mult;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}
