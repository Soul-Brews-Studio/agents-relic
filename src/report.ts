import type { SessionRow } from "./store/lance.js";
import { buildTree, renderTree, commonPrefix } from "./tree.js";

/**
 * A day-by-day activity report — what was worked on, where, and in which worktree.
 *
 * `sessions` answers "the most recent N, newest first", which is a feed. A week is a
 * different question: it has SHAPE — quiet days, spikes, which repo a day belonged to,
 * whether work was in the main checkout or scattered across worktrees. A flat list
 * sorted by time cannot show any of that, and `--limit 40` truncates the answer before
 * the second day starts.
 *
 * Grouping is day -> repo -> worktree -> session, because that is the order the
 * questions actually get asked: "what happened Thursday" then "on which repo" then
 * "which worktree was that".
 *
 * DAYS ARE LOCAL, NOT UTC. A session at 01:30 Bangkok is the previous UTC day, and a
 * report that puts it on the wrong row is wrong about the only axis it exists to show.
 */

const fmt = (n: number) => n.toLocaleString("en-US");
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Local YYYY-MM-DD for an ISO instant — never `.slice(0,10)`, which is UTC. */
export function localDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function localHM(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export interface ReportRow extends SessionRow { repo: string }

export interface ReportSession {
  id: string;
  startedAt: string;
  repo: string;
  worktree: string;
  name: string;
  events: number;        // the whole tree, not just the parent transcript
  transcripts: number;
  files: string[];       // every transcript path, for --tree
}

export interface ReportDay {
  day: string;
  dow: string;
  sessions: ReportSession[];
  events: number;
  transcripts: number;
}

/**
 * Collapse raw transcript rows into day -> session.
 *
 * Takes UNGROUPED rows (one per transcript) rather than the pre-grouped summaries
 * `sessions` renders, because --tree needs every child's PATH and the summary keeps
 * only a count. Grouping here also keeps the parent-picking rule in one place:
 * a session tree's parent is its `session` tier row, falling back to the earliest.
 */
export function buildReport(rows: ReportRow[], nameOf: (r: SessionRow) => string): ReportDay[] {
  const trees = new Map<string, ReportRow[]>();
  for (const r of rows) {
    const k = `${r.repo}\u0000${r.session_uuid || r.file_path}`;
    const prior = trees.get(k);
    if (prior) prior.push(r); else trees.set(k, [r]);
  }

  const byDay = new Map<string, ReportSession[]>();
  for (const group of trees.values()) {
    group.sort((a, b) => String(a.started_at).localeCompare(String(b.started_at)));
    const parent = group.find(r => r.tier === "session") ?? group[0];
    const startedAt = String(parent.started_at || group[0].started_at || "");
    const day = localDay(startedAt);
    if (!day) continue;                       // no timestamp: no day to file it under
    const s: ReportSession = {
      id: String(parent.session_uuid || "").slice(0, 8),
      startedAt, repo: parent.repo, worktree: String(parent.worktree || ""),
      name: nameOf(parent),
      events: group.reduce((a, r) => a + Number(r.event_count ?? 0), 0),
      transcripts: group.length,
      files: group.map(r => String(r.file_path)),
    };
    const prior = byDay.get(day);
    if (prior) prior.push(s); else byDay.set(day, [s]);
  }

  const days: ReportDay[] = [];
  for (const [day, sessions] of byDay) {
    sessions.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    days.push({
      day, dow: DOW[new Date(day + "T12:00:00").getDay()],
      sessions,
      events: sessions.reduce((a, s) => a + s.events, 0),
      transcripts: sessions.reduce((a, s) => a + s.transcripts, 0),
    });
  }
  days.sort((a, b) => b.day.localeCompare(a.day));   // newest day first
  return days;
}

export interface RenderOpts {
  tree?: boolean;
  /**
   * Sessions shown PER REPO, not per day.
   *
   * Per-day was the first shape and it hides the answer: on a busy day one repo has
   * 28 sessions and eats the entire budget, so every other repo touched that day
   * renders as "... and 60 more". The question a report answers is WHICH repos a day
   * belonged to, and a cap that can exclude a whole repo cannot answer it.
   */
  perRepo?: number;
  width?: number;
}

/** The whole report as lines. Pure — the caller prints it. */
export function renderReport(days: ReportDay[], o: RenderOpts = {}): string[] {
  const out: string[] = [];
  const perRepo = o.perRepo ?? 4;
  const width = o.width ?? 78;

  for (const d of days) {
    const head = `${d.day}  ${d.dow}`;
    const tail = `${fmt(d.sessions.length)} session${d.sessions.length === 1 ? "" : "s"}` +
                 ` · ${fmt(d.transcripts)} transcripts · ${fmt(d.events)} ev`;
    out.push("");
    out.push(`${head}  ${"─".repeat(Math.max(2, width - head.length - tail.length - 2))}  ${tail}`);

    // repo -> worktree, so one repo's worktrees sit together under its name.
    const byRepo = new Map<string, ReportSession[]>();
    for (const s of d.sessions) {
      const k = s.repo.replace(/^[^/]+\//, "").replace("github.com/", "");
      const prior = byRepo.get(k);
      if (prior) prior.push(s); else byRepo.set(k, [s]);
    }
    const repos = [...byRepo].sort((a, b) => b[1].length - a[1].length);

    for (const [repo, list] of repos) {
      const ev = list.reduce((a, x) => a + x.events, 0);
      const tag = `${fmt(list.length)}  ${fmt(ev)} ev`;
      out.push(`  ${repo}${" ".repeat(Math.max(1, 52 - repo.length - tag.length))}${tag}`);
      let shown = 0;
      for (const s of list) {
        if (shown++ >= perRepo) break;
        const wt = s.worktree ? `  wt/${s.worktree}` : "";
        const kids = s.transcripts > 1 ? `+${s.transcripts - 1}` : "";
        out.push(`    ${localHM(s.startedAt)}  ${s.id} ${kids.padEnd(5)} ${String(fmt(s.events)).padStart(7)} ev${wt}`);
        if (s.name) out.push(`          ${s.name.replace(/\s+/g, " ").slice(0, width - 12)}`);
        if (o.tree && s.files.length > 1) {
          // The SHAPE of the tree — which run directory held which agents. One common
          // prefix is stripped so the rows are the part that differs.
          const root = commonPrefix(s.files);
          const node = buildTree(s.files.map(p => ({ path: p.slice(root.length), label: "" })));
          renderTree(node, "          ", 6, line => out.push(line));
        }
      }
      if (list.length > perRepo)
        out.push(`    ... and ${fmt(list.length - perRepo)} more in this repo (--per-repo N)`);
    }
  }
  return out;
}
