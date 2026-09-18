import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseClaude } from "./shapes/claude.js";
import { parseCodex } from "./shapes/codex.js";
import { parseOmp } from "./shapes/omp.js";
import { parseVault } from "./shapes/vault.js";
import type { Parser } from "./types.js";

const HOME = homedir();

export interface SourceDef {
  key: string;
  path: string;
  walk: "claude-tiers" | "flat" | "omp" | "vault";   // how to find files under `path`
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
 *   ~/.omp/agent/sessions        <cwd>/<ts>_<id>    YES   (see correction below)
 *   ~/.omx-runs          39 MB   registry + logs    jsonl, but OPS LOGS not conversation
 *   ~/.hermes            56 MB   *.db               no jsonl at all
 *   ~/.copilot           16 KB   *.log              plain logs
 *
 * CORRECTION, 2026-09-18: the line above previously read
 *   "~/.omp/agent  405 MB  history.db  real conversation, but SQLITE"
 * and omp was filed under KNOWN_NON_JSONL as out of scope. That was wrong. It was
 * derived from `du` on ~/.omp/agent plus the presence of history.db — i.e. measuring
 * the directory and reading the DB's name, without listing what else was in it.
 * ~/.omp/agent/sessions/ holds plain per-session JSONL, one event per line, sitting
 * directly beside that database.
 *
 * The cost of the error was not a missing corpus, it was a WRONG ANSWER: an omp agent
 * calling `relic_now` got somebody else's session id back, every time, because omp had
 * no source of its own to be found in and the lookup fell through to whichever Claude
 * Code transcript was newest in the same directory. Observed live before the fix.
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
    key: "omp", path: join(HOME, ".omp", "agent", "sessions"),
    walk: "omp", parser: parseOmp, enabled: true,
    note: "omp — one dir per encoded cwd, flat <timestamp>_<id>.jsonl inside",
  },
  {
    // Oracle vault notes. DISABLED by default: the path is per-oracle, so there is no
    // correct machine-wide default, and indexing someone's memory vault should be a
    // deliberate act. Enable per-machine via ~/.relic/sources.json, or one-shot with
    // `relic index --corpus oracle-vault --source-path <repo>/psi`.
    //
    // Measured on one vault before building this: 10,058 .md / 19 MB / 92% carrying
    // YAML frontmatter / 94% under 4 KB — i.e. small, structured, and worth one row
    // per note rather than chunking. See src/shapes/vault.ts.
    key: "oracle-vault", path: join(HOME, ".relic-vault-unset"),
    walk: "vault", parser: parseVault, enabled: false,
    note: "Oracle ψ vault markdown — set its path in ~/.relic/sources.json",
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
  // omp's history.db is still SQLite and still unread — but it is an INDEX over the
  // same conversations, not the only copy of them. The JSONL beside it is now a real
  // source (key "omp" above), so this entry is a note about a redundant store, not a
  // gap in coverage.
  { key: "omp-db", path: join(HOME, ".omp", "agent", "history.db"), note: "omp — SQLite mirror of ~/.omp/agent/sessions/*.jsonl, which IS indexed" },
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
    // Let config point a builtin at a real path — the vault's location is per-machine,
    // so its builtin entry ships with a placeholder and MUST be repointed here.
    for (const [k, v] of Object.entries(cfg.path ?? {})) {
      const s = out.find(x => x.key === k);
      if (s && typeof v === "string") { s.path = v; s.enabled = true; }
    }
    for (const a of cfg.add ?? []) {
      out.push({
        key: String(a.key), path: String(a.path),
        // walk and shape are INDEPENDENT knobs and both must be mapped explicitly.
        // Defaulting shape to parseClaude while accepting walk:"vault" would walk a
        // vault correctly and then parse every note with the transcript parser — which
        // yields zero events per file and looks exactly like an empty vault.
        walk: a.walk === "claude-tiers" ? "claude-tiers"
            : a.walk === "vault" ? "vault"
            : a.walk === "omp" ? "omp"
            : "flat",
        parser: a.shape === "codex" ? parseCodex
              : a.shape === "vault" ? parseVault
              : a.shape === "omp" ? parseOmp
              : parseClaude,
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
