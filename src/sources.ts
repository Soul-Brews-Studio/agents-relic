import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseClaude } from "./shapes/claude.js";
import { parseCodex } from "./shapes/codex.js";
import type { Parser } from "./types.js";

const HOME = homedir();

export interface SourceDef {
  key: string;
  path: string;
  walk: "claude-tiers" | "flat";   // how to find files under `path`
  parser: Parser;
  enabled: boolean;                // default; overridable by config and --corpus
  note: string;
}

/**
 * Agent transcript sources.
 *
 * Surveyed on this machine 2026-09-18 — of every coding agent present, only two write
 * conversation transcripts as JSONL:
 *
 *   ~/.claude/projects   24 GB   3 tiers            YES
 *   ~/.codex/sessions    14 GB   rollouts           YES
 *   ~/.omx-runs          39 MB   registry + logs    jsonl, but OPS LOGS not conversation
 *   ~/.omp/agent         405 MB  history.db         real conversation, but SQLITE
 *   ~/.hermes            56 MB   *.db               no jsonl at all
 *   ~/.copilot           16 KB   *.log              plain logs
 *
 * So the defaults are claude + codex. Everything else is opt-in and honest about what
 * it would actually give you — indexing ops logs as if they were conversation is how
 * a search corpus quietly fills with noise.
 */
export const BUILTIN: SourceDef[] = [
  {
    key: "claude-live", path: join(HOME, ".claude", "projects"),
    walk: "claude-tiers", parser: parseClaude, enabled: true,
    note: "Claude Code — session / subagent / workflow_agent",
  },
  {
    key: "claude-archive", path: join(HOME, ".claude", "projects-archive"),
    walk: "claude-tiers", parser: parseClaude, enabled: true,
    note: "Claude Code archive",
  },
  {
    key: "codex", path: join(HOME, ".codex", "sessions"),
    walk: "flat", parser: parseCodex, enabled: true,
    note: "Codex CLI rollouts",
  },
  {
    key: "omx-logs", path: join(HOME, ".omx-runs"),
    walk: "flat", parser: parseClaude, enabled: false,
    note: "omx run logs — OPS LOGS, not conversation. Opt in only if you want them.",
  },
];

/**
 * Not JSONL, so out of scope for this tool as written — but recorded here so the gap
 * is visible rather than forgotten. Both hold real history behind a different reader.
 */
export const KNOWN_NON_JSONL = [
  { key: "omp", path: join(HOME, ".omp", "agent", "history.db"), note: "omp/omx-box — SQLite: history, history_fts, session_titles" },
  { key: "hermes", path: join(HOME, ".hermes"), note: "Hermes — SQLite (kanban.db, profiles/*/state.db)" },
];

/**
 * User config, so adding a source needs no code change:
 *
 *   ~/.relic/sources.json
 *   { "disable": ["claude-archive"],
 *     "add": [{ "key": "work", "path": "/other/root", "walk": "flat", "shape": "claude" }] }
 */
export function loadSources(): SourceDef[] {
  const out = BUILTIN.map(s => ({ ...s }));
  const cfgPath = join(HOME, ".relic", "sources.json");
  if (!existsSync(cfgPath)) return out;
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    for (const k of cfg.disable ?? []) { const s = out.find(x => x.key === k); if (s) s.enabled = false; }
    for (const k of cfg.enable ?? []) { const s = out.find(x => x.key === k); if (s) s.enabled = true; }
    for (const a of cfg.add ?? []) {
      out.push({
        key: String(a.key), path: String(a.path),
        walk: a.walk === "claude-tiers" ? "claude-tiers" : "flat",
        parser: a.shape === "codex" ? parseCodex : parseClaude,
        enabled: a.enabled !== false,
        note: String(a.note ?? "user-configured"),
      });
    }
  } catch { /* a broken config must not stop an index run */ }
  return out;
}

/** What is actually on this machine, for the `sources` command. */
export function detect(): { key: string; path: string; present: boolean; enabled: boolean; note: string }[] {
  return loadSources().map(s => ({
    key: s.key, path: s.path, present: existsSync(s.path), enabled: s.enabled, note: s.note,
  }));
}
