#!/usr/bin/env bun
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { discover, parseSince, type Found } from "./discover.js";
import { detect, KNOWN_NON_JSONL } from "./sources.js";
import { trace, readTrace, tracePath } from "./trace.js";
import { classify, logSkipped, readSkipped, skippedPath } from "./noise.js";
import { renderChain } from "./chain.js";
import { localDateTime, localTime, zoneOffset } from "./time.js";
import { currentSession, liveSessions, treeFiles, activityBuckets, sparkline, humanAge } from "./live.js";
import { dig as runDig, defaultProjectDirs } from "./dig.js";
import { Shards, importFiles, type ImportOpts, type ImportTally } from "./import.js";
import { searchEvents, listSessions, resolveSession, chainOf, readAround, pickShards, toISO,
         statsOf, neighbours, nameOf, staleness } from "./query.js";
import { repoKeyOf, cwdOfFile, ghqRoot, defaultRoot, listShards } from "./repo.js";

function flags(argv: string[]) {
  const f: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) f[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[k] = argv[++i];
      else f[k] = true;
    } else pos.push(a);
  }
  return { f, pos };
}
const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Output mode. `plain` and `jsonl` are line-oriented so they compose with the rest of
 * the shell — one record per line, no decoration, nothing on stdout but data. Progress
 * and errors already go to stderr, so `relic search ... --plain | xargs ...` is safe.
 */
type Fmt = "pretty" | "plain" | "json" | "jsonl";
function outFmt(f: Record<string, string | boolean>): Fmt {
  if (f.json) return "json";
  if (f.jsonl) return "jsonl";
  if (f.plain) return "plain";
  const v = String(f.format ?? "");
  return v === "json" || v === "jsonl" || v === "plain" ? v : "pretty";
}

// ---- index -----------------------------------------------------------------
async function cmdIndex(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const inRepo = Boolean(f["in-repo"]);
  const skipNoise = Boolean(f["skip-noise"]);
  const only = f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null;
  const sinceMs = parseSince(f.since as string | undefined);

  const t0 = Date.now();
  const mode = [only ? only.join("+") : "all enabled sources",
                sinceMs ? `since ${localDateTime(sinceMs)}` : "full history",
                f.repo ? `repo~${f.repo}` : null,
                f["dry-run"] ? "DRY RUN — no writes" : null].filter(Boolean).join(" · ");
  console.log(`\u{1F3FA} relic indexing  (${mode})`);
  let found = discover(only, sinceMs);

  // --repo scopes the index to one repo — "personal memory" rather than fleet-wide.
  // Cheap prefilter first: the encoded project dir name contains the repo name with
  // "/" and "." both mapped to "-", so a substring test on it rejects most files
  // WITHOUT opening them. The authoritative check still happens after parse, against
  // the session's own cwd, because the encoding is lossy and cannot be reversed.
  const repoFilter = f.repo ? String(f.repo) : null;
  let prefiltered = 0;
  if (repoFilter) {
    const needle = repoFilter.replace(/[/.]/g, "-");
    const before = found.length;
    found = found.filter(x => x.projectDir.includes(needle) || x.source === "codex");
    prefiltered = before - found.length;
  }
  if (f["dry-run"]) { process.stderr.write("--dry-run: nothing written\n"); return; }

  // One importer, shared with `session`'s on-demand path — a second copy of this loop
  // would drift the moment either side changed.
  const tally = await importFiles(found, {
    dataRoot, inRepo, skipNoise, repoFilter, verbose: Boolean(f.verbose), progress: true,
  }, t0);
  const { added, skipped, failed, filtered, imported } = tally;
  const skipped_noise = tally.skippedNoise;
  const shards = tally.shards;
  const indexed = shards.keys().length;
  const idxSecs = "0.0";
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const byTier = new Map<string, number>();
  for (const x of found) byTier.set(`${x.source}/${x.tier}`, (byTier.get(`${x.source}/${x.tier}`) ?? 0) + 1);

  console.log(`  scanned:     ${fmt(found.length + prefiltered)} files`);
  for (const [k, v] of [...byTier].sort((a, b) => b[1] - a[1]))
    console.log(`               ${String(fmt(v)).padStart(7)}  ${k}`);
  if (prefiltered) console.log(`  prefiltered: ${fmt(prefiltered)} (name did not match --repo, never opened)`);
  if (filtered)    console.log(`  other-repo:  ${fmt(filtered)} (parsed, cwd belongs elsewhere)`);
  console.log(`  unchanged:   ${fmt(skipped)} (mtime+size match, never re-read)`);
  console.log(`  imported:    ${fmt(imported)} files -> ${fmt(added)} events`);
  if (skipped_noise) console.log(`  noise:       ${fmt(skipped_noise)} events dropped (--skip-noise) -> relic skipped`);
  if (failed) console.log(`  \u26A0 failed:    ${fmt(failed)} (re-run with --verbose to see why)`);
  console.log(`  shards:      ${shards.size} repo${shards.size === 1 ? "" : "s"}, ${indexed} fts index built in ${idxSecs}s`);
  console.log(`  wrote:       ${dataRoot ?? (inRepo ? "in-repo .relic/" : defaultRoot())} in ${secs}s`);
}

// ---- search ----------------------------------------------------------------
async function cmdSearch(q: string, f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const limit = Number(f.limit ?? 20);
  const scope = { dataRoot, inRepo: Boolean(f["in-repo"]), repo: f.repo ? String(f.repo) : undefined };

  if (!pickShards(scope).length) {
    const where = dataRoot ?? (Boolean(f["in-repo"]) ? `${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot());
    console.log(`no shards found in  ${where}\n`);
    console.log(`  index one first:   relic index --since 7d${dataRoot ? ` --data-root ${dataRoot}` : ""}`);
    if (!dataRoot) console.log(`  or point elsewhere: relic search ... --data-root /path/to/index`);
    return;
  }

  const { hits, shards: searched, ms } = await searchEvents(q, {
    ...scope, limit,
    tier: f.tier as string, source: f.source as string, worktree: f.worktree as string,
    path: f.path as string, role: f.role as string, prose: Boolean(f.prose),
    org: f.org as string, project: f.project as string, dir: f.dir as string,
    since: f.since as string, until: f.until as string,
    allTiers: Boolean(f["all-tiers"] || f.tier),
  });

  const filters: Record<string, string> = {};
  for (const k of ["repo", "worktree", "path", "tier", "source"]) if (f[k]) filters[k] = String(f[k]);
  trace({
    ts: new Date().toISOString(), q, chars: [...q].length, filters,
    shards: searched, hits: hits.length, ms, top_repo: hits[0]?.repo ?? "", fts: true,
  }, dataRoot);

  const top = hits.slice(0, limit);
  const mode = outFmt(f);

  if (mode === "json") {
    console.log(JSON.stringify({ query: q, shards: searched, ms: Math.round(ms), total: hits.length, hits: top }, null, 2));
    return;
  }
  if (mode === "jsonl") {
    for (const h of top) console.log(JSON.stringify(h));
    return;
  }
  if (mode === "plain") {
    // file<TAB>seq<TAB>repo<TAB>one-line text — greppable, cuttable, xargs-able
    for (const h of top)
      console.log([h.file_path, h.seq, h.repo, h.text.replace(/\s+/g, " ").slice(0, 200)].join("\t"));
    return;
  }

  if (!hits.length) { console.log(`no matches for ${q} across ${searched} shards (${ms} ms)`); return; }
  const narrowed = !f["all-tiers"] && !f.tier;
  console.log(`${Math.min(hits.length, limit)} of ${hits.length} match(es) for ${q} · ${searched} shards · ${ms} ms` +
    (narrowed ? `  ·  main sessions only — add --all-tiers for subagent/workflow work` : "") + "\n");
  for (const h of hits.slice(0, limit)) {
    const i = h.text.toLowerCase().indexOf(q.toLowerCase());
    const snip = i < 0 ? h.text.slice(0, 160) : h.text.slice(Math.max(0, i - 60), i + q.length + 80);
    const wt = h.worktree ? `  [${h.worktree}]` : "";
    console.log(`${h.repo.replace("github.com/", "")}${wt}  ${h.source}/${h.tier}  ${h.role} ${h.ts}`);
    console.log(`  ...${snip.replace(/\s+/g, " ").trim()}...`);
    console.log(`  -> show ${h.file_path} --seq ${h.seq}\n`);
  }
}

// ---- show ------------------------------------------------------------------
async function cmdShow(path: string, f: Record<string, string | boolean>) {
  // A result RETURNED is not a result USED. `opened` is the stronger signal for which
  // shards have a constituency, so record it the moment someone actually reads a hit.
  trace({
    ts: new Date().toISOString(), q: "", chars: 0, filters: {},
    shards: 0, hits: 0, ms: 0, fts: true,
    top_repo: repoKeyOf(await cwdOfFile(path)) ?? "",
    opened: path,
  }, (f["data-root"] as string) ?? null);

  for (const l of await readAround(path, Number(f.seq ?? 1), Number(f.before ?? 2), Number(f.after ?? 2)))
    console.log(`${l.target ? ">>" : "  "} #${l.seq} ${l.role}: ${l.text.replace(/\s+/g, " ").slice(0, 300)}`);
}
// ---- session (resolve one id) ----
async function cmdSession(id: string, f: Record<string, string | boolean>) {
  const scope = { dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
                  repo: f.repo ? String(f.repo) : undefined };
  const { rows, imported, matchedBy } = await resolveSession(id, {
    ...scope, noIndex: Boolean(f["no-index"]), skipNoise: Boolean(f["skip-noise"]),
  });
  if (imported) process.stderr.write(`not indexed — found ${imported} file(s) on disk, imported\n`);

  const mode = outFmt(f);
  if (mode === "jsonl") { for (const r of rows) console.log(JSON.stringify(r)); return; }
  if (mode === "plain") { for (const r of rows) console.log(r.file_path); return; }

  if (!rows.length) {
    if (mode === "json") { console.log(JSON.stringify({ query: id, matchedBy, matches: 0, sessions: [] }, null, 2)); return; }
    console.log(`nothing matches ${id} — tried it as an id, then as a name`);
    console.log(`  a name is matched against the session's title and opening message`);
    console.log(`  the file may exist but be unindexed — try: relic index --since 30d`);
    return;
  }

  // A NAME can match several distinct sessions. Listing them is the answer; picking one
  // would be a guess, and the id is right there to disambiguate with.
  const uuids = new Set(rows.map(r => r.session_uuid));
  if (matchedBy === "name" && uuids.size > 1) {
    if (mode === "json") { console.log(JSON.stringify({ query: id, matchedBy, matches: uuids.size, sessions: rows }, null, 2)); return; }
    console.log(`${uuids.size} sessions named like "${id}"\n`);
    for (const r of rows)
      console.log(`${localDateTime(r.started_at)}  ${r.session_uuid.slice(0, 8)}  ` +
                  `${String(r.event_count).padStart(6)} ev  ${r.repo.replace("github.com/", "")}  ${nameOf(r)}`);
    console.log(`\npick one:  relic session <id>`);
    return;
  }

  const st = statsOf(rows)!;
  const parent = rows.find(r => r.tier === "session") ?? rows[0];
  const nb = f["no-neighbours"] ? { before: [], after: [] } : await neighbours(parent, scope);

  if (mode === "json") {
    console.log(JSON.stringify({ query: id, matchedBy, name: nameOf(parent), stats: st,
      sessions: rows, neighbours: nb }, null, 2));
    return;
  }

  const wt = st.worktree ? ` [${st.worktree}]` : "";
  console.log(`${nameOf(parent)}\n`);
  console.log(`${parent.session_uuid}  ·  matched by ${matchedBy}  ·  ${st.repo.replace("github.com/", "")}${wt}`);
  console.log(`${localDateTime(st.startedAt)} → ${localDateTime(st.endedAt)}` +
              `  ·  ${fmt(st.transcripts)} transcript${st.transcripts === 1 ? "" : "s"}  ·  ${fmt(st.events)} ev` +
              (st.runs ? `  ·  ${st.runs} workflow run${st.runs === 1 ? "" : "s"}` : "") + `  ·  UTC${zoneOffset()}`);
  console.log(`  ${st.tiers.map(t => `${t.tier} ${t.n}`).join(" · ")}${st.model ? `  ·  ${st.model}` : ""}`);
  // Say it rather than let the reader discover it by diffing two commands.
  const stale = staleness(parent);
  if (stale)
    console.log(`  (!) index is ${humanAge(stale.behindSec)} behind this file — it has grown since import.` +
                `  reindex: relic index --since 1d --repo ${st.repo.split("/").pop()}`);

  // The neighbourhood. A session is a stretch of a longer thread of work, and the
  // question right after "which session was that" is "what came before it".
  if (nb.before.length || nb.after.length) {
    console.log(`\nsame worktree, either side:`);
    const line = (r: typeof parent, mark: string) =>
      console.log(`${mark} ${localDateTime(r.started_at)}  ${r.session_uuid.slice(0, 8)}  ` +
                  `${String(r.event_count).padStart(6)} ev  ${nameOf(r).slice(0, 56)}`);
    for (const r of nb.before) line(r, "  ");
    line(parent, ">>");
    for (const r of nb.after) line(r, "  ");
  }

  // Children live UNDER the parent transcript's own directory, so their full paths
  // repeat a 120-char prefix 121 times and bury the part that differs. Print the
  // parent absolute once and everything else relative to it.
  const limit = Number(f.limit ?? 10);
  const base = parent.file_path.replace(/\.jsonl$/, "/");
  console.log(`\ntranscripts (under ${base}):`);
  for (const r of rows.slice(0, limit)) {
    const p = r.file_path === parent.file_path ? parent.file_path
            : r.file_path.startsWith(base) ? r.file_path.slice(base.length) : r.file_path;
    console.log(`  ${localTime(r.started_at)}  ${r.tier.padEnd(14)} ${String(r.event_count).padStart(6)} ev  ${p}`);
  }
  if (rows.length > limit) console.log(`  ... and ${rows.length - limit} more (--limit N, or --plain for full paths)`);
  if (rows.length > 1) console.log(`\nrelic chain ${parent.session_uuid.slice(0, 8)}  — the same tree on a time axis`);
}

// ---- sessions ----
async function cmdSessions(f: Record<string, string | boolean>) {
  const scope = { dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
                  repo: f.repo ? String(f.repo) : undefined };
  if (!pickShards(scope).length) { console.log("no shards match"); return; }

  const { rows: top, total, transcripts, events, shards } = await listSessions({
    ...scope, limit: Number(f.limit ?? 40),
    since: f.since as string, until: f.until as string, worktree: f.worktree as string,
    group: !f["all-tiers"],
  });
  void shards;
  const since = toISO(f.since);

  const mode = outFmt(f);
  if (mode === "json")  { console.log(JSON.stringify({ total, transcripts, sessions: top }, null, 2)); return; }
  if (mode === "jsonl") { for (const r of top) console.log(JSON.stringify(r)); return; }
  if (mode === "plain") { for (const r of top) console.log([r.session_uuid, r.started_at, r.repo, r.worktree, r.event_count].join("\t")); return; }

  if (f.count) { console.log(`${total} sessions`); return; }
  console.log(`${fmt(total)} sessions · ${fmt(transcripts)} transcripts · ${fmt(events)} events` +
    (since ? ` · since ${localDateTime(since)}` : "") + (f.repo ? ` · repo~${f.repo}` : "") + ` · times UTC${zoneOffset()}` + "\n");
  for (const r of top) {
    const wt = r.worktree ? `  [${r.worktree}]` : "";
    const kids = r.children ? ` +${r.children}` : "";
    console.log(`${localDateTime(r.started_at)}  ${r.session_uuid.slice(0, 8)}${kids.padEnd(5)}  ${String(r.treeEvents).padStart(6)} ev  ${r.repo.replace("github.com/", "")}${wt}`);
    console.log(`    ${nameOf(r).replace(/\s+/g, " ").slice(0, 96)}`);
  }
  if (total > top.length) console.log(`\n... and ${total - top.length} more (--limit N)`);
}

// ---- status ----------------------------------------------------------------
async function cmdStatus(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const shards = listShards(dataRoot, Boolean(f["in-repo"]));
  if (!shards.length) {
    const where = dataRoot ?? (Boolean(f["in-repo"]) ? `${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot());
    console.log(`no shards found in  ${where}\n`);
    console.log(`  index one first:   relic index --since 7d${dataRoot ? ` --data-root ${dataRoot}` : ""}`);
    if (!dataRoot) console.log(`  or point elsewhere: relic status --data-root /path/to/index`);
    return;
  }
  const smode = outFmt(f);
  if (smode === "json" || smode === "jsonl") {
    const rows: { key: string; ev: number; se: number }[] = [];
    for (const sh of shards) {
      try { const c = await (await LanceStore.open(sh.dir)).counts(); rows.push({ key: sh.key, ev: c.events, se: c.sessions }); }
      catch { /* skip unreadable shard */ }
    }
    rows.sort((a, b) => b.ev - a.ev);
    if (smode === "jsonl") { for (const r of rows) console.log(JSON.stringify(r)); }
    else console.log(JSON.stringify({ root: dataRoot ?? defaultRoot(), shards: rows.length,
      events: rows.reduce((a, r) => a + r.ev, 0), sessions: rows.reduce((a, r) => a + r.se, 0), rows }, null, 2));
    return;
  }
  console.log(`layout  ${dataRoot ?? (Boolean(f["in-repo"]) ? `in-repo ${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot())}`);
  console.log(`store   LanceDB + ICU full-text index (BM25)\n`);

  const rows: { key: string; ev: number; se: number }[] = [];
  for (const s of shards) {
    try { const c = await (await LanceStore.open(s.dir)).counts(); rows.push({ key: s.key, ev: c.events, se: c.sessions }); }
    catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => b.ev - a.ev);
  const limit = Number(f.limit ?? 15);
  for (const r of rows.slice(0, limit))
    console.log(`  ${r.key.replace("github.com/", "").padEnd(48)} ${String(r.se).padStart(6)} sess ${fmt(r.ev).padStart(10)} ev`);
  if (rows.length > limit) console.log(`  ... and ${rows.length - limit} more (--limit N)`);
  console.log(`\ntotal   ${fmt(rows.reduce((a, r) => a + r.ev, 0))} events · ${fmt(rows.reduce((a, r) => a + r.se, 0))} sessions · ${rows.length} shards`);
  console.log("vectors: none yet — they land in the same `events` table, no migration.");
}

// ---- now (liveness, from mtime — never the index) ---------------------------
async function cmdNow(f: Record<string, string | boolean>) {
  const windowSec = Number(f.window ?? 300);
  const mode = outFmt(f);

  if (f.all) {
    const live = await liveSessions(windowSec, Number(f.limit ?? 20));
    if (mode === "json") { console.log(JSON.stringify({ windowSec, sessions: live }, null, 2)); return; }
    if (mode === "plain") { for (const s of live) console.log([s.sessionUuid, s.ageSec, s.agents, s.cwd ?? ""].join("\t")); return; }
    if (!live.length) { console.log(`nothing written in the last ${humanAge(windowSec)}`); return; }
    console.log(`${live.length} session${live.length === 1 ? "" : "s"} active in the last ${humanAge(windowSec)}\n`);
    for (const s of live) {
      console.log(`${humanAge(s.ageSec).padStart(5)} ago  ${s.sessionUuid.slice(0, 8)}  ` +
        `${String(s.agents).padStart(3)} live agent${s.agents === 1 ? " " : "s"}  ${s.title ?? "(untitled)"}`);
      console.log(`            ${s.cwd ?? s.projectDir}`);
    }
    return;
  }

  const cur = await currentSession();
  if (!cur) {
    console.log(`no session transcript for this directory`);
    console.log(`  ${process.cwd()}`);
    console.log(`  relic now --all   to see every active session on this machine`);
    return;
  }

  const all = treeFiles(cur.projectDir, cur.sessionUuid);
  const liveFiles = all.filter(x => x.ageSec <= windowSec);

  if (mode === "json") {
    console.log(JSON.stringify({ current: cur, windowSec, transcripts: all.length, live: liveFiles }, null, 2));
    return;
  }
  if (mode === "plain") { console.log(cur.sessionUuid); return; }

  console.log(`${cur.title ?? "(untitled)"}\n`);
  console.log(`${cur.sessionUuid}  ·  last write ${humanAge(cur.ageSec)} ago`);
  console.log(`${cur.cwd}`);
  // The encoding maps both "/" and "." to "-", so two checkouts CAN land in the same
  // project directory. Say so rather than presenting a guess as a fact.
  if (!cur.confident)
    console.log(`(!) this transcript's own cwd is ${cur.cwd} — it may belong to another checkout`);
  console.log(`${all.length} transcript${all.length === 1 ? "" : "s"} in the tree\n`);

  const agents = liveFiles.filter(x => x.tier !== "session");
  if (agents.length) {
    console.log(`live agents (written in the last ${humanAge(windowSec)}):`);
    for (const a of agents.slice(0, Number(f.limit ?? 15)))
      console.log(`  ${humanAge(a.ageSec).padStart(5)} ago  ${a.tier.padEnd(14)} ${a.agentId ?? ""}` +
                  (a.workflowRunId ? `  ${a.workflowRunId}` : ""));
    if (agents.length > 15) console.log(`  ... and ${agents.length - 15} more`);
  } else {
    console.log(`no agents running (nothing but the session itself written in ${humanAge(windowSec)})`);
  }

  // Timeline: WHEN the tree was touched, bucketed. mtime is the last write per file, so
  // this maps activity rather than volume.
  const mins = Number(f.minutes ?? 60);
  const b = activityBuckets(all, mins, 40);
  const active = b.counts.filter(c => c > 0).length;
  console.log(`\nlast ${mins}m  |${sparkline(b.counts)}|  ${active}/40 buckets active` +
              ` (${b.perBucketMin.toFixed(1)}m each)`);
  console.log(`         ${new Date(b.startMs).toTimeString().slice(0, 5)}` +
              `${" ".repeat(34)}${localTime(b.endMs)}`);
}

// ---- main ------------------------------------------------------------------
const { f, pos } = flags(process.argv.slice(2));
const cmd = pos[0];

if (!cmd || f.help) {
  console.log(`relic — per-repo LanceDB index of Claude Code + Codex session JSONL

  index   [--corpus ...] [--since 7d] [--repo SUBSTR] [--skip-noise] [--dry-run]
  search  <query> [--repo S] [--org S] [--project S] [--dir S] [--all-tiers] [--worktree S] [--path S] [--tier ...] [--source ...]
                  [--since 7d|2026-09-01] [--until DATE] [--limit N]
                  [--prose]  humans + assistant only — 80% of a transcript is tool traffic
                  [--role user|assistant|tool_use|tool_result|thinking]
  show    <file> --seq N [--before 2] [--after 2]
  session <id|prefix>          resolve a session id to its transcript file(s)
  chain   <id|prefix>          the session tree on one time axis — what ran in parallel
  mcp                          run the MCP server on stdio (same lookups, for a model)
  now [--all] [--window 300]   what is running RIGHT NOW — this session, its live agents
  dig [N] [--deep] [--no-cache] session timeline as JSON — dig.py contract, all 3 tiers
  sessions [--repo S] [--since 24h] [--worktree S] [--count] [--limit 40]
  status  [--limit 15]
  sources                      what this machine has, and what is on/off
  skipped                      what --skip-noise dropped, and the proof
  trace   [--limit 10] [--cloud]  query log: who answers, what is dead, keyword cloud
  ui      [--port 4477]        local viewer: click a repo, search, read context

  --in-repo          write <ghq>/<org>/<repo>/.relic/ instead of ~/.relic
  --data-root PATH   explicit index location
  --json --jsonl --plain   machine output (or --format json|jsonl|plain)
                     plain = file<TAB>seq<TAB>repo<TAB>text, one per line

Sharded per repo, ghq-style, under $HOME by default:
  ${defaultRoot()}/github.com/<org>/<repo>/

LanceDB only, with an ICU full-text index: real Thai word segmentation, and
2-character queries work (trigram cannot do either). Vectors land in the same
table later, no migration.`);
  process.exit(0);
}

if (cmd === "index") await cmdIndex(f);
else if (cmd === "search") { if (!pos[1]) { console.error("search needs a query"); process.exit(1); } await cmdSearch(pos.slice(1).join(" "), f); }
else if (cmd === "show") { if (!pos[1]) { console.error("show needs a file"); process.exit(1); } await cmdShow(pos[1], f); }
else if (cmd === "sources") {
  console.log("configured sources (~/.relic/sources.json overrides)\n");
  for (const s of detect())
    console.log(`  ${s.enabled ? "[on] " : "[off]"} ${s.key.padEnd(16)} ${s.present ? "present" : "MISSING"}  ${s.path}\n         ${s.note}`);
  console.log("\nreal history that is NOT jsonl — needs a different reader:");
  for (const k of KNOWN_NON_JSONL) console.log(`  [--]  ${k.key.padEnd(16)} ${k.path}\n         ${k.note}`);
}
else if (cmd === "ui") {
  const { serve } = await import("./ui.js");
  await serve({ port: Number(f.port ?? 4477), dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]) });
}
else if (cmd === "trace") {
  const cloud = Boolean(f.cloud);
  const dataRoot = (f["data-root"] as string) ?? null;
  const shards = listShards(dataRoot, Boolean(f["in-repo"])).map(s => s.key);
  const t = readTrace(dataRoot, shards);
  const tmode = outFmt(f);
  if (t && (tmode === "json" || tmode === "jsonl")) {
    if (tmode === "jsonl") { for (const x of t.terms) console.log(JSON.stringify(x)); }
    else console.log(JSON.stringify(t, null, 2));
  }
  else if (!t) { console.log(`no queries logged yet — ${tracePath(dataRoot)}`); }
  else {
    console.log(`${t.total} queries · ${t.span} · median ${t.medianMs} ms\n`);
    console.log("answered by (top hit's repo)");
    for (const r of t.byRepo.slice(0, Number(f.limit ?? 10)))
      console.log(`  ${String(r.n).padStart(5)}  ${r.repo.replace("github.com/", "")}`);
    if (t.byFilter.length) {
      console.log("\nfilters used");
      for (const x of t.byFilter) console.log(`  ${String(x.n).padStart(5)}  --${x.filter}`);
    }
    if (t.opened) {
      console.log(`\nactually opened (${t.opened} reads) — the real constituency`);
      for (const r of t.openedByRepo.slice(0, 8))
        console.log(`  ${String(r.n).padStart(5)}  ${(r.repo || "(unresolved)").replace("github.com/", "")}`);
    }
    console.log(`\nzero-hit queries: ${t.zeroHit}/${t.total}`);
    if (t.slowest.length) {
      console.log("slowest");
      for (const s2 of t.slowest) console.log(`  ${String(s2.ms).padStart(6)} ms  ${s2.q.slice(0, 48)}`);
    }
    if (cloud && t.terms.length) {
      // Terminal has no font sizes, so weight is the size cue. Same log scale the
      // fleet's tag cloud uses: size = log(n)/log(max), bucketed into four tiers.
      // Single-use terms are dropped — a cloud of 1:1 entries is all noise.
      const shown = t.terms.filter(x => x.n > 1);
      const max = shown[0]?.n ?? 1;
      const BIG = "\x1b[1;97m", MID = "\x1b[1m", LOW = "\x1b[0m", DIM = "\x1b[2m", OFF = "\x1b[0m";
      const tier = (n: number) => {
        const r = Math.log(n + 1) / Math.log(max + 1);
        return r > 0.85 ? BIG : r > 0.6 ? MID : r > 0.35 ? LOW : DIM;
      };
      console.log(`\nquery cloud — ${t.terms.length} distinct terms, ${shown.length} asked more than once\n`);
      let line = "", width = 0;
      for (const { term, n } of shown.slice(0, 60)) {
        const label = tier(n) + term + OFF + DIM + "·" + n + OFF;
        const w = [...term].length + String(n).length + 2;
        if (width + w > 76) { console.log("  " + line); line = ""; width = 0; }
        line += label + "   "; width += w + 3;
      }
      if (line) console.log("  " + line);
      if (shown.length === 0)
        console.log("  (every term asked exactly once — nothing repeats yet)");
    }

    if (t.neverTop.length)
      console.log(`\n${t.neverTop.length} shard(s) never produced a best hit — no constituency:\n  ` +
        t.neverTop.slice(0, 12).map(s2 => s2.replace("github.com/", "")).join("\n  "));
  }
}
else if (cmd === "chain") {
  if (!pos[1]) { console.error("chain needs a session id or prefix"); process.exit(1); }
  const { chain, imported } = await chainOf(pos[1], {
    dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
    noIndex: Boolean(f["no-index"]), skipNoise: Boolean(f["skip-noise"]),
  });
  if (imported) process.stderr.write(`not indexed — found ${imported} file(s) on disk, imported\n`);
  if (!chain) console.log(`no session matches ${pos[1]}`);
  else if (outFmt(f) === "json") console.log(JSON.stringify(chain, null, 2));
  else console.log(renderChain(chain, { width: Number(f.width ?? 40), maxRows: Number(f.limit ?? 8) }));
}
else if (cmd === "session") { if (!pos[1]) { console.error("session needs an id or prefix"); process.exit(1); } await cmdSession(pos[1], f); }
else if (cmd === "sessions") await cmdSessions(f);
else if (cmd === "skipped") {
  const dataRoot = (f["data-root"] as string) ?? null;
  const st = readSkipped(dataRoot);
  if (!st) { console.log(`nothing skipped yet — ${skippedPath(dataRoot)}`); }
  else if (outFmt(f) === "json") console.log(JSON.stringify(st, null, 2));
  else {
    console.log(`${fmt(st.total)} events dropped · ${(st.bytes / 1e6).toFixed(1)} MB of text\n`);
    for (const r of st.byRule)
      console.log(`  ${r.rule.padEnd(26)} ${String(fmt(r.n)).padStart(7)}  ${(r.bytes / 1e6).toFixed(2).padStart(7)} MB`);
    console.log("\nproof — what each rule actually dropped:");
    let last = "";
    for (const x of st.samples) {
      if (x.rule !== last) { console.log(`\n  [${x.rule}]`); last = x.rule; }
      console.log(`    ${String(x.bytes).padStart(6)}b  ${x.head.slice(0, 92)}`);
      console.log(`            ${x.file_path.split("/").pop()} --seq ${x.seq}`);
    }
  }
}
else if (cmd === "dig") {
  // PROJECT_DIRS is the contract the /dig skill already exports — honour it so this is
  // a drop-in for `python3 dig.py`, not a second thing to configure.
  const env = (process.env.PROJECT_DIRS ?? "").split(":").filter(Boolean);
  const rows = await runDig({
    projectDirs: env.length ? env : defaultProjectDirs(),
    count: Number(pos[1] ?? f.limit ?? 10),
    deep: Boolean(f.deep || f.subagents),
    dataRoot: (f["data-root"] as string) ?? null,
    noCache: Boolean(f["no-cache"]),
  });
  console.log(JSON.stringify(rows, null, 2));
}
else if (cmd === "now" || cmd === "live") await cmdNow(f);
else if (cmd === "mcp") {
  // exec rather than import: the server owns stdin/stdout for its whole lifetime.
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  // fileURLToPath, NOT url.pathname — pathname is percent-encoded, so a repo living
  // under a non-ASCII directory (this one sits below `ψ/`) resolves to a %CF%88 path
  // that does not exist. It fails only on the machines that have such a path.
  const here = fileURLToPath(new URL("./mcp.ts", import.meta.url));
  spawn(process.execPath, [here, ...process.argv.slice(3)], { stdio: "inherit" })
    .on("exit", c => process.exit(c ?? 0));
}
else if (cmd === "status") await cmdStatus(f);
else { console.error(`unknown command: ${cmd}`); process.exit(1); }
