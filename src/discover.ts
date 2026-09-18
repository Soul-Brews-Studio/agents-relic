import { readdirSync, statSync, existsSync, lstatSync, realpathSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { bankOf, loadSources } from "./sources.js";
import { hermesSessions } from "./shapes/hermes.js";
import type { Parser } from "./types.js";

// "note" is not a transcript tier — a vault document has no turns. It shares the
// enum so the whole query surface (search/show/sessions/MCP) stays one code path.
export type Tier = "session" | "subagent" | "workflow_agent" | "note" | "memory";

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

    for (const sessionDir of dirs(projectPath)) {
      const subagents = join(projectPath, sessionDir, "subagents");
      if (!existsSync(subagents)) continue;

      for (const f of files(subagents)) {
        const p = join(subagents, f);
        const st = statOf(p);
        if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
        out.push({ path: p, projectDir: project, tier: "subagent", source: srcKey,
          workflowRunId: null, agentId: basename(f, ".jsonl"), ...st, parser });
      }

      // --- the tier everyone forgets ------------------------------------------
      const workflows = join(subagents, "workflows");
      if (!existsSync(workflows)) continue;
      for (const run of dirs(workflows)) {
        if (!run.startsWith("wf_")) continue;
        for (const f of files(join(workflows, run))) {
          const p = join(workflows, run, f);
          const st = statOf(p);
          if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
          out.push({ path: p, projectDir: project, tier: "workflow_agent", source: srcKey,
            workflowRunId: run, agentId: basename(f, ".jsonl"), ...st, parser });
        }
      }
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
 * Oracle vault: `<repo>/ψ/**.md`.
 *
 * Bounded by extension and by an explicit skip list, NOT by depth — the vault nests
 * arbitrarily (`ψ/memory/retrospectives/2026-09/18/…`) so a depth cap would silently
 * drop the deepest and most recent notes. `node_modules` and `.git` are skipped
 * because lab subprojects inside the vault carry both, and vendored markdown is
 * 280 files of other people's READMEs, not vault content.
 */
function walkVault(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser, depth = 0, onFound?: () => void) {
  if (depth > 12) return;                     // pathological-symlink guard, not a scope limit
  for (const f of files(root, ".md")) {
    const p = join(root, f);
    const st = statOf(p);
    if (!st || (sinceMs && st.mtime * 1000 < sinceMs)) continue;
    out.push({ path: p, projectDir: srcKey, tier: "note", source: srcKey,
      workflowRunId: null, agentId: null, ...st, parser });
  }
  for (const d of dirs(root)) {
    if (d === "node_modules" || d === ".git") continue;
    walkVault(join(root, d), sinceMs, out, srcKey, parser, depth + 1, onFound);
  }
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
 * Worktrees need no special case: they live at <org>/<repo>/wt/<name>, one level
 * below what this enumerates.
 */
function walkVaults(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  // Resolve every candidate FIRST, then walk. Two passes because the dedup below is
  // containment, not equality, and containment needs the full set before it can
  // decide — which is only knowable once everything is resolved.
  const resolved: string[] = [];
  for (const org of dirs(root)) {
    const orgPath = join(root, org);
    for (const repo of dirs(orgPath)) {
      const psi = join(orgPath, repo, "\u03c8");
      try {
        // lstat first: existsSync FOLLOWS the link, so a dead one is already false —
        // but a live one must be resolved before `dirs()` refuses to see it.
        lstatSync(psi);
        resolved.push(realpathSync(psi));
      } catch { /* missing, or a dead symlink — contributes nothing */ }
    }
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
   */
  resolved.sort((a, b) => a.length - b.length);
  const kept: string[] = [];
  for (const real of resolved) {
    if (kept.some(k => real === k || real.startsWith(k + "/"))) continue;
    kept.push(real);
  }
  for (const real of kept) walkVault(real, sinceMs, out, srcKey, parser);
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
function walkHermes(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser) {
  const dbs: string[] = [];
  const scan = (dir: string, depth: number) => {
    if (depth > 3) return;
    for (const f of files(dir, ".db")) if (f === "state.db") dbs.push(join(dir, f));
    for (const d of dirs(dir)) scan(join(dir, d), depth + 1);
  };
  scan(root, 0);

  for (const db of dbs) {
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

export function discover(only: string[] | null, sinceMs: number | null): Found[] {
  const out: Found[] = [];
  const tick = () => {
    if (out.length && out.length % 2000 === 0) progressLine(`  scanning… ${out.length.toLocaleString()} files found`);
  };
  for (const src of loadSources()) {
    const wanted = only ? only.includes(src.key) : src.enabled;
    if (!wanted || !existsSync(src.path)) continue;
    progressLine(`  scanning ${src.key}…`);
    const before = out.length;
    if (src.walk === "memory") walkMemory(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "hermes") walkHermes(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "vaults") walkVaults(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "vault") walkVault(src.path, sinceMs, out, src.key, src.parser, 0, tick);
    else if (src.walk === "omp") walkOmp(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "flat") walkFlat(src.path, sinceMs, out, src.key, src.parser);
    else walkClaude(src.path, sinceMs, out, src.key, src.parser);
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
