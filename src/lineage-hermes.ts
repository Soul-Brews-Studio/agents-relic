import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { loadSources } from "./sources.js";
import { hermesDbs } from "./discover.js";
import { chainMembers, peak, type Agents, type Lineage, type LineageNode, type Link } from "./lineage.js";

// session_key is one line of work; parent_session_id is a parallel spawn, never continuation (#74).

export interface HermesRow {
  id: string;
  sessionKey: string | null;
  parentId: string | null;
  startMs: number;
  endMs: number;
  cwd: string | null;
  title: string | null;
  prompt: string | null;
}

/** Pure: consecutive sessions sharing a non-empty key link in start order; spawns never do. */
export function hermesLinks(rows: HermesRow[]): { links: Link[]; childrenOf: Map<string, HermesRow[]> } {
  const ids = new Set(rows.map(r => r.id));
  const childrenOf = new Map<string, HermesRow[]>();
  const byKey = new Map<string, HermesRow[]>();
  for (const r of rows) {
    if (r.parentId && ids.has(r.parentId)) {
      childrenOf.set(r.parentId, [...(childrenOf.get(r.parentId) ?? []), r]);
      continue;
    }
    const key = (r.sessionKey ?? "").trim();
    if (key) byKey.set(key, [...(byKey.get(key) ?? []), r]);
  }

  const links: Link[] = [];
  for (const line of byKey.values()) {
    line.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
    for (let i = 1; i < line.length; i++)
      links.push({ parent: line[i - 1].id, child: line[i].id, kind: "session_key",
                   gapMs: Math.max(0, line[i].startMs - line[i - 1].endMs), via: "ids", ambiguous: false });
  }
  return { links, childrenOf };
}

const secToMs = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n * 1000 : NaN;
};

/** Every session in one DB. Optional columns are probed, since Hermes schemas drift (#60). */
export function readHermes(dbPath: string): HermesRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const have = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(c => c.name));
    const col = (c: string) => (have.has(c) ? `NULLIF(s.${c}, '')` : "NULL");
    const rows = db.query(`
      SELECT s.id AS id,
             ${col("session_key")} AS session_key, ${col("parent_session_id")} AS parent_id,
             ${col("started_at")} AS started_at, ${col("ended_at")} AS ended_at,
             COALESCE(${col("git_repo_root")}, ${col("cwd")}) AS cwd,
             COALESCE(${col("title")}, ${col("display_name")}) AS title,
             MIN(m.timestamp) AS first_ts, MAX(m.timestamp) AS last_ts,
             (SELECT u.content FROM messages u
               WHERE u.session_id = s.id AND u.role = 'user' AND u.active = 1
               ORDER BY u.id LIMIT 1) AS prompt
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id AND m.active = 1
      GROUP BY s.id
    `).all() as Record<string, unknown>[];

    const out: HermesRow[] = [];
    for (const r of rows) {
      const startMs = [secToMs(r.started_at), secToMs(r.first_ts)].filter(Number.isFinite);
      const endMs = [secToMs(r.last_ts), secToMs(r.ended_at)].filter(Number.isFinite);
      if (!startMs.length) continue;
      const start = Math.min(...startMs);
      const prompt = typeof r.prompt === "string" ? r.prompt.trim().split("\n")[0].slice(0, 60) : "";
      out.push({
        id: String(r.id),
        sessionKey: (r.session_key as string) ?? null,
        parentId: (r.parent_id as string) ?? null,
        startMs: start,
        endMs: Math.max(start, endMs[0] ?? start),
        cwd: (r.cwd as string) ?? null,
        title: (r.title as string) ?? null,
        prompt: prompt || null,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

function hermesSources(enabled: boolean): string[] {
  const roots = new Set<string>();
  for (const s of loadSources())
    if (s.walk === "hermes" && s.enabled === enabled && existsSync(s.path)) roots.add(s.path);
  return [...roots];
}

/** Hermes roots on disk whose source is switched off — named in the miss message, never read. */
export function disabledHermesRoots(): string[] {
  return hermesSources(false);
}

/** Hermes roots on disk whose source is on — the only ones read. */
export function enabledHermesRoots(): string[] {
  return hermesSources(true);
}

/** The miss message's last word: data on disk that relic was told not to read. One line per root. */
export function hermesOffNotes(): string[] {
  return disabledHermesRoots().map(r =>
    `(${r} holds Hermes data, but its source is disabled — enable "hermes" in ~/.relic/sources.json)`);
}

/** Every session whose id starts with `prefix`, across enabled Hermes sources. */
export function findHermesSessions(prefix: string, roots = hermesSources(true)): { id: string; db: string }[] {
  const hits: { id: string; db: string }[] = [];
  const seen = new Set<string>();
  for (const db of roots.flatMap(hermesDbs)) {
    if (seen.has(db)) continue;
    seen.add(db);
    let d: Database | null = null;
    try {
      d = new Database(db, { readonly: true });
      const rows = d.query("SELECT id FROM sessions WHERE substr(id, 1, length(?1)) = ?1").all(prefix) as { id: string }[];
      for (const r of rows) hits.push({ id: String(r.id), db });
    } catch (e) {
      process.stderr.write(`hermes: ${db}: ${e instanceof Error ? e.message : String(e)}\n`);
    } finally {
      d?.close();
    }
  }
  return hits;
}

function agentsOf(children: HermesRow[] | undefined): Agents | null {
  if (!children?.length) return null;
  return {
    subagents: children.length, runs: 0, workflowAgents: 0, names: [],
    startMs: Math.min(...children.map(c => c.startMs)),
    endMs: Math.max(...children.map(c => c.endMs)),
    peak: peak(children),
  };
}

export function buildHermesLineage(dbPath: string, target: string, opts: { all?: boolean } = {}): Lineage {
  const rows = readHermes(dbPath);
  const byId = new Map(rows.map(r => [r.id, r]));
  const { links, childrenOf } = hermesLinks(rows);
  const top = rows.filter(r => !(r.parentId && byId.has(r.parentId)));

  // A spawned child has no line of its own; the line it belongs to is its parent's.
  let focus = target;
  for (let i = 0; i < rows.length; i++) {
    const p = byId.get(focus)?.parentId;
    if (!p || !byId.has(p)) break;
    focus = p;
  }
  const keep = chainMembers(top.map(r => r.id), links, focus, Boolean(opts.all));

  const nodes: LineageNode[] = top.filter(r => keep.has(r.id)).map(r => ({
    id: r.id, path: `${dbPath}#${r.id}`, cwd: r.cwd,
    // No file per session, so the last message stands in for the last write.
    startMs: r.startMs, endMs: r.endMs, mtimeMs: r.endMs,
    started: null, title: r.title, prompt: r.prompt, carries: [], marks: [],
    agents: agentsOf(childrenOf.get(r.id)),
  }));
  const cwd = byId.get(focus)?.cwd ?? nodes.find(n => n.cwd)?.cwd ?? null;
  return { projectDir: dbPath, cwd, target, nodes,
           links: links.filter(l => keep.has(l.parent) && keep.has(l.child)) };
}
