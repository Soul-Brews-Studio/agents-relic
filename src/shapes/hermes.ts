import { Database } from "bun:sqlite";
import { truncate, uidOf, type ParsedEvent, type Parser } from "../types.js";

/**
 * Hermes transcripts — SQLite, not JSONL.
 *
 * Verified before writing this (issue #6): Hermes genuinely has no per-session JSONL
 * beside its DB. The two .jsonl files under ~/.hermes are a tool log and a curator
 * ledger, and `sessions/` is a single sessions.json. So unlike the omp correction,
 * nothing was overlooked by measuring the directory — this really is SQLite-only.
 *
 * ONE DB HOLDS MANY SESSIONS, which the `Parser` contract does not: it is one file ->
 * one ParsedFile -> one session. Rather than bend that contract, the walker enumerates
 * sessions and emits one Found per session with a synthetic path:
 *
 *     /path/to/state.db#<session_id>
 *
 * Everything downstream then works unchanged — the manifest keys on that path, uids
 * stay stable, and `show` can still resolve the DB by splitting on '#'.
 *
 * Facets come from the `sessions` row, which carries real `cwd`, `git_branch` and
 * `git_repo_root` — so Hermes sessions shard into the correct repo exactly like a
 * Claude transcript, no path guessing.
 */

const warned = new Set<string>();

/** One stderr line per DB and error, so a schema mismatch is visible without flooding a walk. */
export function warnOnce(dbPath: string, e: unknown): void {
  const msg = e instanceof Error ? e.message : String(e);
  const key = `${dbPath}\0${msg}`;
  if (warned.has(key)) return;
  warned.add(key);
  process.stderr.write(`hermes: ${dbPath}: ${msg}\n`);
}

/** Split "<db path>#<session id>" back into its parts. */
export function splitHermesPath(p: string): { db: string; sessionId: string } {
  const i = p.lastIndexOf("#");
  return i < 0 ? { db: p, sessionId: "" } : { db: p.slice(0, i), sessionId: p.slice(i + 1) };
}

/** Every session id in a Hermes DB, newest activity first. Used by the walker. */
export function hermesSessions(dbPath: string): { id: string; mtime: number; rows: number }[] {
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    // Newest active message, not `last_activity_at`: some 0.19.1 builds lack that column (#60).
    const rows = db.query(`
      SELECT s.id AS id,
             COALESCE(MAX(m.timestamp), s.started_at, 0) AS ts,
             COUNT(m.id) AS n
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id AND m.active = 1
      GROUP BY s.id
      HAVING n > 0
      ORDER BY ts DESC, s.id
    `).all() as { id: string; ts: number; n: number }[];
    return rows.map(r => ({
      id: String(r.id),
      // Hermes timestamps are REAL unix seconds; relic's manifest wants seconds too.
      mtime: Math.floor(Number(r.ts) || 0),
      rows: Number(r.n) || 0,
    }));
  } catch (e) {
    warnOnce(dbPath, e);
    return [];
  }
  finally { db?.close(); }
}

/** REAL unix seconds -> ISO. Hermes stores fractional seconds, not millis. */
function toISO(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "";
  return new Date(n * 1000).toISOString();
}

/**
 * Map Hermes roles onto relic's vocabulary.
 *
 * `tool` is machine output and must not read as something a human said — the same
 * mislabelling that buried 68.5% of the Claude index under a `user` label.
 */
function roleOf(role: string, toolName: string | null): string {
  if (role === "tool") return "tool_result";
  if (role === "session_meta") return "system";
  if (role === "assistant" && toolName) return "tool_use";
  return role;             // user | assistant
}

export const parseHermes: Parser = async (filePath) => {
  const { db: dbPath, sessionId } = splitHermesPath(filePath);
  const events: ParsedEvent[] = [];
  const typeCounts: Record<string, number> = {};
  let cwd: string | null = null, model: string | null = null;
  let gitBranch: string | null = null, title: string | null = null;
  let description: string | null = null;
  let startedAt: string | null = null, endedAt: string | null = null;
  let lines = 0;

  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });

    const s = db.query(`
      SELECT cwd, git_branch, git_repo_root, model, title, display_name, started_at, ended_at
      FROM sessions WHERE id = ?
    `).get(sessionId) as Record<string, unknown> | null;

    if (s) {
      // git_repo_root is a real path, so repoKeyOf shards this exactly like a
      // transcript. cwd alone can be a subdirectory; prefer the repo root when present.
      cwd = (s.git_repo_root as string) || (s.cwd as string) || null;
      gitBranch = (s.git_branch as string) || null;
      model = (s.model as string) || null;
      title = (s.title as string) || (s.display_name as string) || null;
      startedAt = toISO(s.started_at) || null;
      endedAt = toISO(s.ended_at) || null;
    }

    /*
     * active = 1 excludes rows Hermes has retired; compacted rows are a compressed
     * restatement of messages still present, so indexing both would double-count the
     * same conversation. Both are exact column predicates — no heuristics, unlike
     * --skip-noise, which has to guess from text shape.
     */
    const rows = db.query(`
      SELECT id, role, content, tool_name, timestamp
      FROM messages
      WHERE session_id = ? AND active = 1 AND COALESCE(compacted, 0) = 0
      ORDER BY id
    `).all(sessionId) as Record<string, unknown>[];

    lines = rows.length;
    let seq = 0;
    for (const r of rows) {
      seq++;
      const role = roleOf(String(r.role ?? ""), (r.tool_name as string) ?? null);
      typeCounts[role] = (typeCounts[role] ?? 0) + 1;

      const text = String(r.content ?? "").trim();
      if (!text) continue;

      const ts = toISO(r.timestamp);
      if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }
      if (!description && role === "user") description = truncate(text, 200);

      events.push({
        // The row id is stable and monotonic within a DB, so the uid survives
        // re-imports without depending on ordering.
        uid: uidOf("hermes", `${dbPath}#${sessionId}`, Number(r.id)),
        seq, role, ts, text: truncate(text),
      });
    }
  } catch (e) {
    // Unreadable, locked or schema-drifted -> empty session, never a crash, but never silent.
    warnOnce(dbPath, e);
  }
  finally { db?.close(); }

  return {
    sessionUuid: sessionId,
    cwd, model, events,
    lines, badLines: 0, typeCounts,
    startedAt, endedAt, description, title, gitBranch,
  };
};
