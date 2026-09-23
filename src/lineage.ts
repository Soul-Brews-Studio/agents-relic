import { openSync, readSync, closeSync, statSync, readdirSync, existsSync, createReadStream } from "node:fs";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { loadSources } from "./sources.js";
import { encodeProjectDir, treeFiles } from "./live.js";
import { dur, zoneOffset } from "./time.js";
import { stripEnvelope } from "./types.js";

/**
 * Which session ids are ONE line of work.
 *
 * Claude Code gives a new id on /clear and on every relaunch, and keeps the id across
 * /compact. Nothing in either transcript names the other, so the chain is rebuilt from
 * three observed signals: the child's SessionStart hook source (or its /clear turn),
 * the parent's last event, and the parent's final write — /clear and exit both flush a
 * cost-state line into the OLD file at the moment the new one starts.
 */

export type StartKind = "startup" | "clear" | "resume" | "compact";
export type LinkKind = "fork" | "clear" | "relaunch";

export interface Mark { kind: "compact" | "resume"; atMs: number }

export interface Agents {
  subagents: number;
  runs: number;
  workflowAgents: number;
  names: string[];
  startMs: number;
  endMs: number;
  peak: number;
}

export interface LineageNode {
  id: string;
  path: string;
  cwd: string | null;
  startMs: number;
  endMs: number;
  mtimeMs: number;
  started: StartKind | null;
  title: string | null;
  prompt: string | null;
  carries: string[];
  marks: Mark[];
  agents: Agents | null;
}

export interface Link {
  parent: string;
  child: string;
  kind: LinkKind;
  gapMs: number;
  via: "ids" | "mtime" | "last-event";
  ambiguous: boolean;
}

export interface Lineage {
  projectDir: string;
  cwd: string | null;
  target: string;
  nodes: LineageNode[];
  links: Link[];
}

export const WINDOWS = { flushMs: 5_000, relaunchMs: 60_000, adjacencyMs: 120_000 };

const CHUNK = 64 * 1024;

function readChunk(path: string, fromEnd: boolean): { text: string; whole: boolean } {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const total = statSync(path).size;
    const len = Math.min(CHUNK, total);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, fromEnd ? total - len : 0);
    return { text: buf.toString("utf8"), whole: len === total };
  } catch {
    return { text: "", whole: true };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function records(path: string, fromEnd: boolean): any[] {
  const { text, whole } = readChunk(path, fromEnd);
  const parts = text.split("\n");
  // The chunk edge cuts one line in half; drop it rather than misparse it.
  if (!whole) { if (fromEnd) parts.shift(); else parts.pop(); }
  const out: any[] = [];
  for (const p of parts) {
    if (!p.trim()) continue;
    try { out.push(JSON.parse(p)); } catch { /* half-written line on a live file */ }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map(b => (b && typeof b === "object" && typeof (b as any).text === "string") ? (b as any).text : "").join(" ");
  return "";
}

const tsOf = (r: any) => (typeof r?.timestamp === "string" ? Date.parse(r.timestamp) : NaN);

/** Everything but marks and agents, from the first and last 64 KB only. */
export function probe(path: string, id: string): LineageNode {
  const head = records(path, false);
  const tail = records(path, true);
  let startMs = Infinity, endMs = -Infinity;
  let started: StartKind | null = null, cwd: string | null = null, prompt: string | null = null;
  let custom: string | null = null, ai: string | null = null;
  const carries = new Set<string>();

  for (const r of head) {
    const t = tsOf(r);
    if (Number.isFinite(t)) { startMs = Math.min(startMs, t); endMs = Math.max(endMs, t); }
    if (!cwd && typeof r.cwd === "string") cwd = r.cwd;
    if (typeof r.sessionId === "string" && r.sessionId && r.sessionId !== id) carries.add(r.sessionId);
    const hook = r.attachment?.hookName;
    if (!started && typeof hook === "string" && hook.startsWith("SessionStart:"))
      started = hook.slice("SessionStart:".length) as StartKind;
    if (r.type === "user" && !r.isMeta) {
      const text = textOf(r.message?.content).trim();
      if (!started && text.includes("<command-name>/clear</command-name>")) started = "clear";
      const said = stripEnvelope(text);
      if (!prompt && said && !said.startsWith("<")) prompt = said.split("\n")[0].slice(0, 60);
    }
    if (r.type === "custom-title" && typeof r.customTitle === "string") custom = r.customTitle;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") ai = r.aiTitle;
  }
  for (const r of tail) {
    const t = tsOf(r);
    if (Number.isFinite(t)) endMs = Math.max(endMs, t);
    if (r.type === "custom-title" && typeof r.customTitle === "string") custom = r.customTitle;
    if (r.type === "ai-title" && typeof r.aiTitle === "string") ai = r.aiTitle;
  }

  let mtimeMs = NaN;
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* vanished between readdir and stat */ }
  return { id, path, cwd, startMs, endMs, mtimeMs, started, title: custom ?? ai, prompt,
           carries: [...carries], marks: [], agents: null };
}

/** Compacts and in-place resumes keep the id, so they are marks inside a node, not links. */
export async function scanMarks(path: string, startMs: number): Promise<Mark[]> {
  const out: Mark[] = [];
  let lastResume = -Infinity;
  const rl = createInterface({ input: createReadStream(path, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    const compact = line.includes('"compact_boundary"');
    const resume = !compact && line.includes("SessionStart:resume");
    if (!compact && !resume) continue;
    let r: any;
    try { r = JSON.parse(line); } catch { continue; }
    const t = tsOf(r);
    if (!Number.isFinite(t)) continue;
    if (compact && r.type === "system" && r.subtype === "compact_boundary") out.push({ kind: "compact", atMs: t });
    // One resume fires every SessionStart hook, each writing its own attachment.
    else if (resume && r.attachment?.hookName === "SessionStart:resume" && t > startMs + 5_000 && t - lastResume > 5_000) {
      out.push({ kind: "resume", atMs: t });
      lastResume = t;
    }
  }
  return out;
}

const NAMED_AGENT = /^agent-a(.+)-[0-9a-f]{16}$/;

function peak(spans: { startMs: number; endMs: number }[]): number {
  const edges: [number, number][] = [];
  for (const s of spans) edges.push([s.startMs, 1], [Math.max(s.endMs, s.startMs), -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, best = 0;
  for (const [, d] of edges) { cur += d; best = Math.max(best, cur); }
  return best;
}

export function agentsOf(projectDir: string, id: string): Agents | null {
  const files = treeFiles(projectDir, id).filter(f => f.tier !== "session");
  if (!files.length) return null;
  const spans = files.map(f => probe(f.path, id)).filter(n => Number.isFinite(n.startMs));
  const direct = files.filter(f => f.tier === "subagent");
  const named = direct.map(f => NAMED_AGENT.exec(f.agentId ?? "")?.[1]).filter((n): n is string => !!n);
  return {
    subagents: direct.length,
    runs: new Set(files.map(f => f.workflowRunId).filter(Boolean)).size,
    workflowAgents: files.filter(f => f.tier === "workflow_agent").length,
    names: named.length === direct.length ? named.sort() : [],
    startMs: Math.min(...spans.map(s => s.startMs)),
    endMs: Math.max(...spans.map(s => s.endMs)),
    peak: peak(spans),
  };
}

/**
 * Pure: who continued whom.
 *
 * A process continues into exactly one next session, so each parent keeps at most one
 * clear/relaunch child — a /clear marker beats a bare relaunch, then the smaller gap.
 */
export function inferLinks(nodes: LineageNode[], w = WINDOWS): Link[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const forks: Link[] = [];
  const best = new Map<string, Link>();

  for (const c of nodes) {
    const carried = c.carries.map(id => byId.get(id))
      .filter((p): p is LineageNode => !!p && p.startMs < c.startMs)
      .sort((a, b) => b.endMs - a.endMs);
    if (carried.length) {
      const p = carried[0];
      forks.push({ parent: p.id, child: c.id, kind: "fork", gapMs: Math.max(0, c.startMs - p.endMs),
                   via: "ids", ambiguous: false });
      continue;
    }

    // Anything still writing after the child began is a neighbour, not a parent.
    const earlier = nodes.filter(p => p.id !== c.id && p.startMs < c.startMs && p.endMs <= c.startMs + 1_000);
    let cands: { p: LineageNode; via: Link["via"] }[];
    if (c.started === "clear") {
      cands = earlier.filter(p => Math.abs(c.startMs - p.mtimeMs) <= w.flushMs).map(p => ({ p, via: "mtime" as const }));
      // A copied bank loses mtimes; fall back to the last event, which survives a copy.
      if (!cands.length)
        cands = earlier.filter(p => c.startMs - p.endMs <= w.adjacencyMs).map(p => ({ p, via: "last-event" as const }));
    } else {
      cands = earlier.filter(p => p.mtimeMs <= c.startMs + 1_000 && c.startMs - p.mtimeMs <= w.relaunchMs)
        .map(p => ({ p, via: "mtime" as const }));
    }
    if (!cands.length) continue;
    cands.sort((a, b) => (c.startMs - a.p.endMs) - (c.startMs - b.p.endMs));
    const link: Link = {
      parent: cands[0].p.id, child: c.id, kind: c.started === "clear" ? "clear" : "relaunch",
      gapMs: Math.max(0, c.startMs - cands[0].p.endMs), via: cands[0].via, ambiguous: cands.length > 1,
    };
    const prev = best.get(link.parent);
    const rank = (l: Link) => (l.kind === "clear" ? 0 : 1e15) + l.gapMs;
    if (!prev || rank(link) < rank(prev)) best.set(link.parent, link);
  }
  return [...forks, ...best.values()];
}

function claudeRoots(): string[] {
  const seen = new Set<string>();
  for (const s of loadSources())
    if (s.walk === "claude-tiers" && s.enabled && existsSync(s.path)) seen.add(s.path);
  return [...seen];
}

function jsonlIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name);
  } catch { return []; }
}

function subdirs(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
}

export function isClaudeProjectDir(dir: string): boolean {
  return claudeRoots().some(root => dirname(dir) === root);
}

/** Every Claude transcript whose id starts with `prefix` — this cwd's project dir first. */
export function findSessions(prefix: string, cwd = process.cwd()): { id: string; projectDir: string }[] {
  const roots = claudeRoots();
  const match = (dir: string) => jsonlIn(dir).filter(f => f.startsWith(prefix))
    .map(f => ({ id: f.slice(0, -".jsonl".length), projectDir: dir }));

  for (let d = cwd; ; ) {
    for (const root of roots) {
      const hits = match(join(root, encodeProjectDir(d)));
      if (hits.length) return hits;
    }
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }

  const seen = new Map<string, { id: string; projectDir: string }>();
  for (const root of roots)
    for (const proj of subdirs(root))
      for (const hit of match(join(root, proj)))
        if (!seen.has(hit.id)) seen.set(hit.id, hit);
  return [...seen.values()];
}

export async function buildLineage(projectDir: string, target: string, opts: { all?: boolean } = {}): Promise<Lineage> {
  const nodes = jsonlIn(projectDir)
    .map(f => probe(join(projectDir, f), f.slice(0, -".jsonl".length)))
    .filter(n => Number.isFinite(n.startMs));
  const links = inferLinks(nodes);

  const parentOf = new Map(links.map(l => [l.child, l.parent]));
  const kids = new Map<string, string[]>();
  for (const l of links) kids.set(l.parent, [...(kids.get(l.parent) ?? []), l.child]);

  let keep: Set<string>;
  if (opts.all) keep = new Set(nodes.map(n => n.id));
  else {
    let root = target;
    const seen = new Set<string>();
    while (parentOf.has(root) && !seen.has(root)) { seen.add(root); root = parentOf.get(root)!; }
    keep = new Set<string>();
    const stack = [root];
    while (stack.length) {
      const id = stack.pop()!;
      if (keep.has(id)) continue;
      keep.add(id);
      stack.push(...(kids.get(id) ?? []));
    }
  }

  const members = nodes.filter(n => keep.has(n.id));
  for (const n of members) {
    n.marks = await scanMarks(n.path, n.startMs);
    n.agents = agentsOf(projectDir, n.id);
  }
  const cwd = members.find(n => n.id === target)?.cwd ?? members.find(n => n.cwd)?.cwd ?? null;
  return { projectDir, cwd, target, nodes: members,
           links: links.filter(l => keep.has(l.parent) && keep.has(l.child)) };
}

// ---- rendering --------------------------------------------------------------

const p2 = (n: number) => String(n).padStart(2, "0");
function stamp(ms: number, withDate: boolean, seconds = true): string {
  const d = new Date(ms);
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}` + (seconds ? `:${p2(d.getSeconds())}` : "");
  return withDate ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${t}` : t;
}
const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

function agentsLine(a: Agents): string {
  const parts: string[] = [];
  if (a.subagents) {
    const names = a.names.length && a.names.length <= 6 ? `: ${a.names.join(", ")}` : "";
    parts.push(`${a.subagents} subagent${a.subagents === 1 ? "" : "s"}${names}`);
  }
  if (a.runs) parts.push(`${a.runs} workflow run${a.runs === 1 ? "" : "s"} (${a.workflowAgents} agents)`);
  const span = sameDay(a.startMs, a.endMs)
    ? `${stamp(a.startMs, false, false)}–${stamp(a.endMs, false, false)}`
    : `${stamp(a.startMs, true, false)} → ${stamp(a.endMs, true, false)}`;
  return `${parts.join(" + ")} · ${span} · peak ${a.peak} at once`;
}

function markLines(n: LineageNode): string[] {
  const out: string[] = [];
  for (const kind of ["compact", "resume"] as const) {
    const ms = n.marks.filter(m => m.kind === kind).map(m => m.atMs);
    if (!ms.length) continue;
    const label = kind === "compact" ? "compact" : "resumed";
    const at = (t: number) => stamp(t, !sameDay(t, n.startMs));
    if (ms.length <= 3) for (const t of ms) out.push(`${label} ${at(t)}  (same id)`);
    else out.push(`${label} ×${ms.length}  (same id) · first ${at(ms[0])} · last ${at(ms[ms.length - 1])}`);
  }
  return out;
}

function linkLine(l: Link): string {
  const gap = dur(l.gapMs);
  const flag = (l.via === "last-event" ? " · matched on last event" : "") + (l.ambiguous ? " · (!) ambiguous" : "");
  if (l.kind === "clear") return `/clear → new id ${gap} later${flag}`;
  if (l.kind === "fork") return `resumed into a new id ${gap} later · carries the parent's turns`;
  return `relaunch ${gap} later · no marker${flag}`;
}

export function renderLineage(l: Lineage, opts: { now?: number; current?: string | null; liveSec?: number } = {}): string {
  const now = opts.now ?? Date.now();
  const liveMs = (opts.liveSec ?? 300) * 1000;
  const byId = new Map(l.nodes.map(n => [n.id, n]));
  const kids = new Map<string, Link[]>();
  for (const k of l.links) kids.set(k.parent, [...(kids.get(k.parent) ?? []), k]);
  for (const list of kids.values()) list.sort((a, b) => byId.get(a.child)!.startMs - byId.get(b.child)!.startMs);
  const hasParent = new Set(l.links.map(k => k.child));
  const roots = l.nodes.filter(n => !hasParent.has(n.id)).sort((a, b) => a.startMs - b.startMs);

  const out: string[] = [];
  const n = l.nodes.length;
  out.push(`lineage · ${n} session${n === 1 ? "" : "s"} · ${l.cwd ?? l.projectDir} · UTC${zoneOffset()}`);

  const nodeLine = (x: LineageNode) => {
    const live = now - x.mtimeMs <= liveMs;
    const end = live ? "now" : stamp(x.endMs, !sameDay(x.startMs, x.endMs));
    const label = x.title ?? (x.prompt ? `"${x.prompt}"` : "(untitled)");
    const here = x.id === opts.current ? "   ← you are here" : "";
    return `${x.id.slice(0, 8)}  ${stamp(x.startMs, true)} → ${end}   ${dur((live ? now : x.endMs) - x.startMs)}   ${label}${here}`;
  };

  const walk = (x: LineageNode, prefix: string) => {
    out.push(prefix + nodeLine(x));
    const items: ({ text: string } | { link: Link })[] = [
      ...(x.agents ? [{ text: agentsLine(x.agents) }] : []),
      ...markLines(x).map(text => ({ text })),
      ...(kids.get(x.id) ?? []).map(link => ({ link })),
    ];
    items.forEach((it, i) => {
      const last = i === items.length - 1;
      const branch = last ? " └─ " : " ├─ ";
      if ("text" in it) { out.push(prefix + branch + it.text); return; }
      out.push(prefix + branch + linkLine(it.link));
      walk(byId.get(it.link.child)!, prefix + (last ? "    " : " │  "));
    });
  };

  for (const r of roots) { out.push(""); walk(r, ""); }
  return out.join("\n");
}

export function lineageJSON(l: Lineage) {
  const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  return {
    projectDir: l.projectDir, cwd: l.cwd, target: l.target,
    nodes: l.nodes.map(n => ({
      id: n.id, path: n.path, cwd: n.cwd, started: n.started, title: n.title, prompt: n.prompt,
      start: iso(n.startMs), end: iso(n.endMs), lastWrite: iso(n.mtimeMs), carries: n.carries,
      marks: n.marks.map(m => ({ kind: m.kind, at: iso(m.atMs) })),
      agents: n.agents && { ...n.agents, startMs: undefined, endMs: undefined,
                            start: iso(n.agents.startMs), end: iso(n.agents.endMs) },
    })),
    links: l.links,
  };
}
