import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ghq root differs per machine — /opt/Code here, ~/ghq elsewhere. repo.ts already
// shells out to `ghq root` and caches it; guessing the default would have pointed
// this source at a directory that does not exist on this machine.
import { ghqRoot } from "./repo.js";
import { parseClaude } from "./shapes/claude.js";
import { parseCodex } from "./shapes/codex.js";
import { parseOmp } from "./shapes/omp.js";
import { parseVault } from "./shapes/vault.js";
import { parseHermes } from "./shapes/hermes.js";
import { parseMemory } from "./shapes/memory.js";
import type { Parser } from "./types.js";

const HOME = homedir();

export interface SourceDef {
  key: string;
  path: string;
  walk: "claude-tiers" | "claude-home" | "flat" | "omp" | "vault" | "vaults" | "hermes" | "memory";   // how to find files under `path`
  parser: Parser;
  enabled: boolean;                // default; overridable by config and --corpus
  note: string;
  /**
   * The BANK this source writes into — the top level of the shard path:
   *   ~/.relic/<bank>/github.com/<org>/<repo>/
   *
   * Defaults to `key`. The three Claude roots override it so the directory on disk
   * reads as the root it mirrors (`projects`, `projects-archive`, …) rather than an
   * internal key. A bank is a STORAGE namespace, not an identity: the same session
   * can legitimately appear in two banks, and `uid` is what collapses it at read
   * time. See uidOf in types.ts before changing anything here.
   */
  bank?: string;
}

/**
 * AN AGENT HOME, declared in config — the axis the builtin sources get wrong.
 *
 * Claude Code takes its home from CLAUDE_CONFIG_DIR, and the binary is unambiguous
 * about the rule (v2.1.278):
 *
 *     function s(){ return process.env.CLAUDE_CONFIG_DIR }
 *     (s() ?? join(homedir(), ".claude")).normalize("NFC")
 *
 * ONE path, not a list, NFC-normalised. Codex does the same with CODEX_HOME. So a home
 * is a single identity — and the right thing for a BANK to be.
 *
 * The builtins split one home across three banks (`projects`, `projects-archive`,
 * `projects-1sep-tue2026` are all roots inside ~/.claude) while giving another whole
 * home a single bank (`peer-projects`). That axis cannot express "index this other
 * home", which is why ~/.claude-neo sat on this machine with real sessions and zero
 * indexed rows.
 *
 * A declared home expands to ONE source per reading, each with its own bank, and the
 * `claude-home` walk covers every `projects*` root inside it. That keeps one bank per
 * home WITHOUT relaxing the duplicate-bank guard — two sources sharing a bank is the
 * exact shape that guard exists to catch, and widening it to fit this would remove a
 * check that already caught a real incident.
 *
 *   ~/.relic/sources.json
 *   { "homes": [ { "key": "claude-neo", "path": "~/.claude-neo", "agent": "claude" },
 *                { "key": "claude-nat", "path": "/Users/nat/.claude" } ] }
 */
export interface HomeDef { key: string; path: string; agent?: "claude" | "codex" }

/** `~` is the only expansion — a home path is written by a human, in a JSON file. */
function expandHome(p: string): string {
  return p.startsWith("~/") ? join(HOME, p.slice(2)) : p;
}

/**
 * The agent homes this machine's ENVIRONMENT points at, whether or not they are
 * declared. Reported by `relic sources`, never acted on silently.
 *
 * A set CLAUDE_CONFIG_DIR is the case that must not be quiet: relic would index
 * ~/.claude, find whatever is there, and print a clean summary for the wrong home.
 */
export function envHomes(): { agent: string; env: string; path: string; isDefault: boolean }[] {
  const out = [];
  const cc = process.env.CLAUDE_CONFIG_DIR;
  if (cc) out.push({ agent: "claude", env: "CLAUDE_CONFIG_DIR", path: cc.normalize("NFC"),
                     isDefault: cc.normalize("NFC") === join(HOME, ".claude") });
  const cx = process.env.CODEX_HOME;
  if (cx) out.push({ agent: "codex", env: "CODEX_HOME", path: cx,
                     isDefault: cx === join(HOME, ".codex") });
  return out;
}

/** A source's bank, defaulting to its key. The only place this fallback lives. */
export function bankOf(s: SourceDef): string { return s.bank || s.key; }

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
    walk: "claude-tiers", parser: parseClaude, enabled: true, bank: "projects",
    note: "Claude Code — session / subagent / workflow_agent",
  },
  {
    key: "claude-archive", path: join(HOME, ".claude", "projects-archive"),
    walk: "claude-tiers", parser: parseClaude, enabled: true, bank: "projects-archive",
    note: "Claude Code archive",
  },
  {
    /*
     * The largest root on this machine: 25,397 files across 903 directories.
     *
     * It lived ONLY in ~/.relic/sources.json until 2026-09-18, when that file was
     * deleted along with the index and took the definition with it. A rebuild would
     * then have indexed two of three Claude roots and reported success. A root this
     * size is not machine-local trivia; it belongs in version control.
     *
     * Overlaps the other two roots heavily — 342 sessions shared with claude-live,
     * 134 with claude-archive, and every one of claude-archive's 455 project
     * directories also appears here. That duplication is expected and is resolved by
     * uid at read time, NOT by keeping the roots apart.
     */
    key: "claude-1sep", path: join(HOME, ".claude", "projects-1sep-tue2026"),
    walk: "claude-tiers", parser: parseClaude, enabled: true, bank: "projects-1sep-tue2026",
    note: "Claude Code snapshot 1sep-tue2026 — the largest root",
  },
  {
    /*
     * ANOTHER ACCOUNT'S CLAUDE ROOT, on a machine several humans-worth of agents share.
     *
     * Same shape as the three roots above — `claude-tiers`, `parseClaude` — and it is a
     * separate SOURCE rather than a path tweak because it is a separate bank: a bank is
     * one whole source root, and two accounts' `projects/` directories are exactly that.
     * Merging them into one bank would make `--bank projects` mean "whichever account
     * indexed last", and the uid scheme dedups by content, so the overlap is resolved at
     * read time rather than by keeping the roots apart.
     *
     * DISABLED, with a placeholder path, for the same reason as oracle-vault: there is
     * no correct machine-wide default for "the other account", and reading another
     * user's transcripts is a deliberate act. Set the path in ~/.relic/sources.json,
     * which enables it implicitly.
     *
     * Reachable without ssh or a copy when the owner has granted an ACL — measured on
     * m5, 2026-09-19, where /Users/nat/.claude/projects is mode drwx------ and still
     * fully readable by user beta:
     *
     *   0: user:beta allow list,search,readattr,file_inherit,directory_inherit
     *   1: user:beta allow list,search,readattr,readextattr,readsecurity
     *
     *   30,203 .jsonl visible to beta   ==   30,203 visible to nat
     *
     * CHECK THAT EQUALITY BEFORE INDEXING a peer root. A partially-readable tree indexes
     * without error and reports success over whatever it happened to be allowed to see,
     * which is the same silent-incompleteness this tool exists to make visible.
     */
    key: "claude-peer", path: join(HOME, ".relic-peer-unset"),
    walk: "claude-tiers", parser: parseClaude, enabled: false, bank: "peer-projects",
    note: "another account's Claude root on a shared machine — set its path in ~/.relic/sources.json",
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
    walk: "vault", parser: parseVault, enabled: false, bank: "vault",
    note: "ONE oracle's ψ vault — set its path in ~/.relic/sources.json",
  },
  {
    // EVERY oracle's vault, found by walking the ghq tree rather than being told one
    // path. Measured on this machine: 413 repos carry a ψ, 386 distinct after
    // resolving symlinks — against the one that `oracle-vault` can name.
    //
    // Worktree vaults (`<repo>/wt/<slug>/ψ`, `<repo>/agents/<slug>/ψ`) are walked too,
    // and deduped against the repo's main checkout — a worktree is a second checkout of
    // a repo that commits its vault, so walking them without a rule adds 194,863 notes
    // of which 738 are new. See walkVaults in discover.ts for the rule.
    //
    // Off by default and deliberately so: it reads a tree this tool does not own, and
    // on a machine with a different layout the glob finds nothing rather than
    // something wrong. Point it at the host of a ghq root — the level holding <org>/
    // directories, not the ghq root itself.
    //
    // ITS OWN BANK, not "vault". Sharing one with oracle-vault was the first attempt
    // and the duplicate-source guard rejected it on sight — correctly. Two builtins
    // claiming one bank is the exact shape the guard exists to catch, and weakening
    // the guard to fit a new source would have removed a check that already caught a
    // real incident.
    //
    // Separate banks also make the overlap legible rather than silent: enable both
    // and the vault named by oracle-vault appears in "vault" AND in "vaults", which
    // `relic status` shows as two banks. Search collapses the duplicate events by
    // content, so the answer stays right either way.
    key: "oracle-vaults", path: join(ghqRoot(), "github.com"),
    walk: "vaults", parser: parseVault, enabled: false, bank: "vaults",
    note: "EVERY <org>/<repo>/ψ under the ghq tree, worktrees included — symlinks resolved, realpath-deduped",
  },
  {
    // Claude Code's OWN memory — durable typed facts the agent chose to keep, each
    // with a pointer back to the session that produced it. A different kind of thing
    // from a transcript, and the only source that can answer "which session taught me
    // this". Measured: 67 dirs, 227 files, 172 typed, 161 with originSessionId.
    key: "claude-memory", path: join(HOME, ".claude", "projects"),
    walk: "memory", parser: parseMemory, enabled: true, bank: "memory",
    note: "Claude Code memory — typed facts (project/feedback/reference/user)",
  },
  {
    // Hermes — SQLite, not JSONL. Verified (issue #6): there genuinely is no
    // per-session JSONL beside the DB, unlike the omp case. One DB per profile,
    // many sessions each; the walker emits one entry per session.
    key: "hermes", path: join(HOME, ".hermes"),
    walk: "hermes", parser: parseHermes, enabled: false,
    note: "Hermes — SQLite state.db per profile, one entry per session",
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
  // hermes/state.db is now a real source (walk:"hermes"); only kanban.db is unread.
  { key: "hermes-kanban", path: join(HOME, ".hermes", "kanban.db"), note: "Hermes kanban board — not conversation, unread" },
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
    /*
     * Homes expand BEFORE `add`, so an explicit `add` entry can still override one by
     * key — the dup guard keeps the first match, and hand-written beats derived.
     */
    for (const h of cfg.homes ?? []) {
      const key = String(h.key ?? "");
      const path = expandHome(String(h.path ?? ""));
      if (!key || !path) continue;
      const agent = h.agent === "codex" ? "codex" : "claude";
      if (agent === "codex") {
        out.push({ key, path: join(path, "sessions"), walk: "flat", parser: parseCodex,
                   enabled: h.enabled !== false, bank: key,
                   note: `declared Codex home ${path}` });
        continue;
      }
      // Transcripts: every `projects*` root inside the home, ONE source, ONE bank.
      out.push({ key, path, walk: "claude-home", parser: parseClaude,
                 enabled: h.enabled !== false, bank: key,
                 note: `declared Claude home ${path} — all projects* roots` });
      // Memory is a different KIND of thing, so a different bank, exactly as the
      // builtin claude-memory is a second reading of ~/.claude/projects.
      out.push({ key: `${key}-memory`, path: join(path, "projects"), walk: "memory",
                 parser: parseMemory, enabled: h.enabled !== false, bank: `${key}-memory`,
                 note: `declared Claude home ${path} — typed memory facts` });
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
        bank: a.bank ? String(a.bank) : undefined,
      });
    }
  } catch { /* a broken config must not stop an index run */ }

  /*
   * A DUPLICATE SOURCE IS A DOUBLED BANK, and nothing downstream would say so.
   *
   * Re-adding an entry that a builtin already covers — the exact shape of the deleted
   * ~/.relic/sources.json, which defined claude-1sep before it moved in here — yields two
   * sources over one root: the builtin writing bank `projects-1sep-tue2026` and the added
   * one writing bank `claude-1sep`. Both enabled, 25,389 files read and stored twice,
   * `--corpus claude-1sep` matching both, and search hiding the doubling. Only disk and
   * wall-clock would show it. `disable:` cannot switch the copy off either, since `find`
   * returns the first match only.
   *
   * Loud beats silent: drop the later duplicate and say so on stderr.
   */
  const seenKey = new Set<string>(), seenPath = new Set<string>(), seenBank = new Set<string>();
  const kept: SourceDef[] = [];
  for (const s of out) {
    const bank = bankOf(s);
    // claude-live and claude-memory SHARE a path on purpose — two readings of one root —
    // so a path clash is only a duplicate when the bank clashes too.
    const dup = seenKey.has(s.key) ? "key" : seenBank.has(bank) ? "bank"
              : (seenPath.has(s.path) && seenBank.has(bank)) ? "path" : null;
    if (dup) {
      process.stderr.write(`  relic: dropping duplicate source ${s.key} (${dup} already taken — check ~/.relic/sources.json)\n`);
      continue;
    }
    seenKey.add(s.key); seenPath.add(s.path); seenBank.add(bank);
    kept.push(s);
  }
  return kept;
}

/** What is actually on this machine, for the `sources` command. */
/**
 * Which parser handles this file, chosen by the source whose root contains it.
 *
 * Path-based, not content-sniffing: every source already declares its root, and three
 * of the four shapes are newline-delimited JSON that a sniffer would confuse. The
 * fallback is the Claude parser, since that is the only shape whose files can appear
 * outside any configured root (a transcript copied somewhere for inspection).
 */
export function parserFor(filePath: string): Parser {
  let best: SourceDef | null = null;
  const isMd = filePath.endsWith(".md");
  for (const s of loadSources()) {
    if (!filePath.startsWith(s.path)) continue;
    // Memory sources exclusively parse markdown facts, never .jsonl transcripts.
    if (s.walk === "memory" && !isMd) continue;
    // Transcript sources do not parse .md files.
    if ((s.walk === "claude-tiers" || s.walk === "claude-home") && isMd) continue;
    // Longest matching root wins — sources can nest (a vault inside a repo).
    if (!best || s.path.length > best.path.length) best = s;
  }
  if (best) return best.parser;
  return isMd ? parseVault : parseClaude;
}

export function detect(): { key: string; bank: string; path: string; present: boolean; enabled: boolean; note: string }[] {
  return loadSources().map(s => ({
    key: s.key, bank: bankOf(s), path: s.path, present: existsSync(s.path),
    enabled: s.enabled, note: s.note,
  }));
}
