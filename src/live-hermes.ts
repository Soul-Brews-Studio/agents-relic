import { hermesDbs } from "./discover.js";
import { readHermes, hermesLinks, enabledHermesRoots, type HermesRow } from "./lineage-hermes.js";
import { warnOnce } from "./shapes/hermes.js";
import { resolveRepoKey, contextOf } from "./repo.js";
import type { LiveSession } from "./live.js";

/**
 * Hermes, for the two questions live.ts answers from transcript files (#100).
 *
 * Hermes writes no transcript. A session is rows in state.db, so the project-directory
 * sweep behind `now --all` and the encoded-cwd lookup behind a no-argument `tail` both
 * walk past it without a trace — `relic live --all` said "nothing written" while a Hermes
 * conversation was running.
 *
 * This is a PARALLEL lookup, not a new entry in liveRoots(). Everything that consumes
 * those roots (currentSession, sessionIn, the native sweep) assumes an
 * `<encoded-cwd>/<uuid>.jsonl` layout, and a DB is not one.
 *
 * The clock is each session's newest active message, never the file's mtime: one DB holds
 * every session in a profile, so its mtime says that SOMETHING was written, not which.
 */

const ageSec = (ms: number, now: number) => Math.max(0, Math.round((now - ms) / 1000));

/** One DB's sessions. Unreadable or schema-drifted is named on stderr and skipped, never fatal. */
function rowsOf(db: string): HermesRow[] {
  try { return readHermes(db); } catch (e) { warnOnce(db, e); return []; }
}

function dbsUnder(roots: string[]): string[] {
  return [...new Set(roots.flatMap(hermesDbs))];
}

/**
 * Hermes sessions with a message inside the window, as `now --all` rows.
 *
 * A spawn (parent_session_id in the same DB) is its parent's live agent, the way a
 * subagent transcript is — so a 13-way fan-out is one row with 13 agents, not 14 rows
 * crowding everything else out of the limit.
 */
export function hermesLive(windowSec: number, roots = enabledHermesRoots(), now = Date.now()): LiveSession[] {
  const out: LiveSession[] = [];
  for (const db of dbsUnder(roots)) {
    const rows = rowsOf(db);
    const ids = new Set(rows.map(r => r.id));
    const { childrenOf } = hermesLinks(rows);
    for (const r of rows) {
      if (r.parentId && ids.has(r.parentId)) continue;
      const kids = (childrenOf.get(r.id) ?? []).filter(k => ageSec(k.endMs, now) <= windowSec);
      const eventAgeSec = Math.min(ageSec(r.endMs, now), ...kids.map(k => ageSec(k.endMs, now)));
      if (eventAgeSec > windowSec) continue;
      // No file per session, so the last message is both clocks and there are no files.
      out.push({ sessionUuid: r.id, projectDir: db, cwd: r.cwd, title: r.title, files: [],
                 ageSec: eventAgeSec, eventAgeSec, agents: kids.length, source: "hermes" });
    }
  }
  return out;
}

/**
 * Same checkout: the same repo key AND the same worktree inside it.
 *
 * A Claude project directory IS one checkout, so the transcript half of `tail` never has
 * to ask. The repo key alone is too wide for Hermes: a fleet runs sibling worktrees of
 * one repo side by side, and a Hermes session in one of them would outrank this
 * worktree's own transcript. A path outside any repo has no key and must match exactly.
 */
export function sameCheckout(a: string, b: string): boolean {
  const ka = resolveRepoKey(a), kb = resolveRepoKey(b);
  if (!ka || !kb) return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
  return ka === kb && contextOf(a).worktree === contextOf(b).worktree;
}

/**
 * Hermes sessions that ran in the caller's checkout, newest activity first — the half of
 * a no-argument `tail` that no transcript directory can supply.
 *
 * `cwd` is the session's own (git_repo_root first). A gateway session — Discord, say —
 * records none, so it cannot be attributed to a directory and is never offered here.
 *
 * Spawns are left out, as subagent transcripts are: the session before this one is a
 * conversation, not a task it delegated. So is the CALLER's own session, which Hermes
 * names in HERMES_SESSION_ID on every command it runs. Without that, a Hermes agent
 * asking for its predecessor gets itself back — it is always the newest.
 */
export function hermesSessionsIn(cwd: string, roots = enabledHermesRoots(), env = process.env):
  { id: string; path: string; lastMs: number }[] {
  const me = (env.HERMES_SESSION_ID ?? "").trim();
  const out: { id: string; path: string; lastMs: number }[] = [];
  for (const db of dbsUnder(roots)) {
    const rows = rowsOf(db);
    const ids = new Set(rows.map(r => r.id));
    for (const r of rows) {
      if (r.id === me || (r.parentId && ids.has(r.parentId))) continue;
      if (r.cwd && sameCheckout(r.cwd, cwd)) out.push({ id: r.id, path: `${db}#${r.id}`, lastMs: r.endMs });
    }
  }
  return out.sort((a, b) => b.lastMs - a.lastMs);
}
