import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";
import { loadSources } from "./sources.js";
import type { Parser } from "./types.js";

// "note" is not a transcript tier — a vault document has no turns. It shares the
// enum so the whole query surface (search/show/sessions/MCP) stays one code path.
export type Tier = "session" | "subagent" | "workflow_agent" | "note";

export interface Found {
  path: string;
  projectDir: string;      // raw encoded dir name (display only — the encoding is lossy)
  tier: Tier;
  source: string;
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
function walkVault(root: string, sinceMs: number | null, out: Found[], srcKey: string, parser: Parser, depth = 0) {
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
    walkVault(join(root, d), sinceMs, out, srcKey, parser, depth + 1);
  }
}

export function discover(only: string[] | null, sinceMs: number | null): Found[] {
  const out: Found[] = [];
  for (const src of loadSources()) {
    const wanted = only ? only.includes(src.key) : src.enabled;
    if (!wanted || !existsSync(src.path)) continue;
    const before = out.length;
    if (src.walk === "vault") walkVault(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "omp") walkOmp(src.path, sinceMs, out, src.key, src.parser);
    else if (src.walk === "flat") walkFlat(src.path, sinceMs, out, src.key, src.parser);
    else walkClaude(src.path, sinceMs, out, src.key, src.parser);
    void before;
  }
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
