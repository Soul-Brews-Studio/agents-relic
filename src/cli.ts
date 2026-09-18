#!/usr/bin/env bun
import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { discover, parseSince, type Found } from "./discover.js";
import { detect, KNOWN_NON_JSONL } from "./sources.js";
import { trace, readTrace, tracePath } from "./trace.js";
import { classify, logSkipped, readSkipped, skippedPath } from "./noise.js";
import { renderChain } from "./chain.js";
import { buildTree, renderTree, commonPrefix } from "./tree.js";
import { localDateTime, localTime, zoneOffset } from "./time.js";
import { currentSession, liveSessions, treeFiles, activityBuckets, sparkline, humanAge } from "./live.js";
import { dig as runDig, defaultProjectDirs } from "./dig.js";
import { Shards, importFiles, type ImportOpts, type ImportTally } from "./import.js";
import { searchEvents, listSessions, resolveSession, chainOf, readAround, pickShards, toISO,
         statsOf, neighbours, nameOf, staleness, memoryReport, pendingReport,
         groupByBank, maxISO } from "./query.js";
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
  const idxSecs = (tally.ftsMs / 1000).toFixed(1);
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
  console.log(`  shards:      ${shards.size} (bank,repo) pair${shards.size === 1 ? "" : "s"}` +
              `, ${tally.ftsBuilt} fts index built in ${idxSecs}s` +
              (tally.ftsFailed ? `  \u26A0 ${tally.ftsFailed} FAILED — those shards fall back to a slow LIKE scan` : ""));
  console.log(`  wrote:       ${dataRoot ?? (inRepo ? "in-repo .relic/" : defaultRoot())} in ${secs}s`);
}

// ---- search ----------------------------------------------------------------
async function cmdSearch(q: string, f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const limit = Number(f.limit ?? 20);
  const scope = { dataRoot, inRepo: Boolean(f["in-repo"]), repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };

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
    shards: searched, hits: hits.length, ms, // strip the bank — the trace log keys on the bare repo
            top_repo: (hits[0]?.repo ?? "").replace(/^[^/]+\//, ""), fts: true,
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
                  repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };
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

  if (f.tree) {
    const entries = rows.map(r => ({
      path: r.file_path === parent.file_path ? basename(r.file_path)
          : r.file_path.startsWith(base) ? r.file_path.slice(base.length) : r.file_path,
      label: `${localTime(r.started_at)} ${r.tier} ${fmt(r.event_count)} ev`,
      weight: r.event_count,
    }));
    console.log(`\n${base}`);
    renderTree(buildTree(entries), "", Number(f.limit ?? 8));
    console.log(`\n${fmt(rows.length)} transcripts · ${fmt(rows.reduce((n, r) => n + r.event_count, 0))} events`);
    if (rows.length > 1) console.log(`relic chain ${parent.session_uuid.slice(0, 8)}  — the same tree on a time axis`);
    return;
  }

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
                  repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };
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
  let shards = listShards(dataRoot, Boolean(f["in-repo"]));
  if (f.bank) shards = shards.filter(sh => sh.bank === String(f.bank));
  if (!shards.length) {
    const where = dataRoot ?? (Boolean(f["in-repo"]) ? `${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot());
    console.log(`no shards found in  ${where}\n`);
    console.log(`  index one first:   relic index --since 7d${dataRoot ? ` --data-root ${dataRoot}` : ""}`);
    if (!dataRoot) console.log(`  or point elsewhere: relic status --data-root /path/to/index`);
    return;
  }
  const smode = outFmt(f);
  if (smode === "json" || smode === "jsonl") {
    const rows: { key: string; bank: string; repo: string; ev: number; se: number;
                  events: number; sessions: number;
                  lastIndexed: string; newestSession: string }[] = [];
    for (const sh of shards) {
      try {
        const st = await LanceStore.open(sh.dir);
        const c = await st.counts();
        const fr = await st.freshness();
        rows.push({ key: sh.key, bank: sh.bank, repo: sh.repo,
                    // ev/se predate the rest of this row and something may read them.
                    // events/sessions are the names everything else uses.
                    ev: c.events, se: c.sessions, events: c.events, sessions: c.sessions,
                    lastIndexed: fr.lastIndexed, newestSession: fr.newestSession });
      } catch { /* skip unreadable shard */ }
    }
    rows.sort((a, b) => b.ev - a.ev);
    if (smode === "jsonl") { for (const r of rows) console.log(JSON.stringify(r)); }
    else console.log(JSON.stringify({ root: dataRoot ?? defaultRoot(), shards: rows.length,
      events: rows.reduce((a, r) => a + r.ev, 0), sessions: rows.reduce((a, r) => a + r.se, 0), rows }, null, 2));
    return;
  }
  console.log(`layout  ${dataRoot ?? (Boolean(f["in-repo"]) ? `in-repo ${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot())}`);
  console.log(`store   LanceDB + ICU full-text index (BM25)\n`);

  const rows: { bank: string; repo: string; events: number; sessions: number;
                lastIndexed: string; newestSession: string }[] = [];
  for (const s of shards) {
    try {
      const st = await LanceStore.open(s.dir);
      const c = await st.counts();
      const fr = await st.freshness();
      rows.push({ bank: s.bank, repo: s.repo, events: c.events, sessions: c.sessions,
                  lastIndexed: fr.lastIndexed, newestSession: fr.newestSession });
    } catch { /* skip unreadable shard */ }
  }
  // BANK FIRST, then repo. A flat list sorted by size interleaves three snapshots of the
  // same machine, and the reader cannot tell whether one repo appears three times because
  // it is busy or because it exists in three banks.
  const limit = Number(f.limit ?? 15);
  // groupByBank is shared with the MCP server. The two rendered this separately once,
  // and only one of them grouped — which is how the MCP came to print a shard key under
  // the heading "what `repo` accepts".
  const when = (iso: string) => iso ? localDateTime(iso) : "never";
  for (const b of groupByBank(rows)) {
    console.log(`  ${b.bank}   ${fmt(b.sessions)} sessions · ${fmt(b.events)} events · ${b.shards} shards`);
    console.log(`  ${" ".repeat(b.bank.length)}   indexed ${when(b.lastIndexed)} · newest session ${when(b.newestSession)}`);
    for (const r of b.rows.slice(0, limit))
      console.log(`    ${r.repo.replace("github.com/", "").padEnd(46)} ${String(r.sessions).padStart(6)} sess ${fmt(r.events).padStart(10)} ev`);
    if (b.rows.length > limit) console.log(`    ... and ${b.rows.length - limit} more (--limit N)`);
    console.log("");
  }
  console.log(`\ntotal   ${fmt(rows.reduce((a, r) => a + r.events, 0))} events · ${fmt(rows.reduce((a, r) => a + r.sessions, 0))} sessions · ${rows.length} shards`);
  // Two clocks, deliberately both: the index can be fresh over stale material, or stale
  // over fresh material, and only one of those is a problem to act on.
  console.log(`last indexed  ${when(maxISO(rows.map(r => r.lastIndexed)))}` +
              `   ·   newest session  ${when(maxISO(rows.map(r => r.newestSession)))}`);
  console.log("vectors: none yet — they land in the same `events` table, no migration.");
}

// ---- banks / shards (layout, no engine) ------------------------------------
//
// Both also exist in the native binary, which is why they are safe for the
// dispatcher to route: two implementations of the SAME output, pinned by
// test/native-parity.test.ts. A command that exists in only one of them would print
// something different depending on whether a binary was built.
function cmdBanks(f: Record<string, string | boolean>) {
  const shards = listShards((f["data-root"] as string) ?? null, Boolean(f["in-repo"]));
  const names = [...new Set(shards.map(s => s.bank))].sort();
  if (outFmt(f) === "json") { console.log(JSON.stringify(names, null, 2)); return; }
  if (!names.length) { console.error("no shards indexed"); process.exit(1); }
  for (const n of names) console.log(n);
}

function cmdShards(f: Record<string, string | boolean>) {
  let shards = listShards((f["data-root"] as string) ?? null, Boolean(f["in-repo"]));
  // --bank is EXACT, --repo is a substring of the REPO PORTION. Matching --repo
  // against the key would make `--repo projects` select a whole bank, since every
  // key begins with its bank name.
  if (f.bank) shards = shards.filter(s => s.bank === String(f.bank));
  if (f.repo) shards = shards.filter(s => s.repo.includes(String(f.repo)));
  if (f.count) { console.log(String(shards.length)); return; }
  if (outFmt(f) === "json") {
    console.log(JSON.stringify(shards.map(s => ({ key: s.key, bank: s.bank, repo: s.repo, dir: s.dir })), null, 2));
    return;
  }
  for (const s of shards) console.log(`${s.key}\t${s.dir}`);
}

// ---- backend (which engine answers what) -----------------------------------
async function cmdBackend(f: Record<string, string | boolean>) {
  const { nativeInfo, liveRoots, freshCandidates } = await import("./live.js");
  const info = nativeInfo();
  const mode = outFmt(f);

  if (mode === "json") { console.log(JSON.stringify(info, null, 2)); return; }

  console.log(`native binary   ${info.path ?? "(none found)"}`);
  console.log(`                ${info.usable ? "usable" : info.reason}`);
  console.log(`RELIC_NATIVE    ${process.env.RELIC_NATIVE ?? "(unset — auto-detect)"}`);
  console.log(`engine          lancedb 0.39.0 — the SAME Rust core in every front end\n`);
  console.log(`accelerated by the binary (pure readdir/stat, no engine):`);
  console.log(`  now · sessions liveness      the sweep over every project directory`);
  console.log(`  banks · shards               enumerate the index layout\n`);
  console.log(`NOT accelerated, on purpose:`);
  console.log(`  search · status · sessions · session · chain · pending · memory`);
  console.log(`  they are bound by lancedb, and every front end wraps the same core,`);
  console.log(`  so a second implementation would swap identical engines.\n`);

  if (!f.probe) { console.log(`--probe   time both engines on this machine`); return; }

  const roots = liveRoots();
  const time = async (v: string | undefined) => {
    const prev = process.env.RELIC_NATIVE;
    if (v === undefined) delete process.env.RELIC_NATIVE; else process.env.RELIC_NATIVE = v;
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t = Bun.nanoseconds();
      await freshCandidates(roots, 3600);
      runs.push((Bun.nanoseconds() - t) / 1e6);
    }
    if (prev === undefined) delete process.env.RELIC_NATIVE; else process.env.RELIC_NATIVE = prev;
    runs.sort((a, b) => a - b);
    return runs[2];   // median of 5 — a single run measures the page cache
  };
  const ts = await time("0");
  const nat = info.usable ? await time(undefined) : null;
  console.log(`probe — live scan over ${roots.length} roots, median of 5:`);
  console.log(`  typescript    ${ts.toFixed(0).padStart(5)} ms`);
  if (nat === null) console.log(`  native        n/a (${info.reason})`);
  else console.log(`  native        ${nat.toFixed(0).padStart(5)} ms   ${(ts / nat).toFixed(1)}x`);
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

/*
 * BACKEND SELECTION, before any command runs.
 *
 * The native binary accelerates the index-free scans only, and it does so from
 * INSIDE the TypeScript path (src/live.ts) rather than by replacing a command — so
 * the flag has to be set before a command reads it, and it is expressed as the same
 * env var the library already honours rather than as a second mechanism.
 *
 * The engine-bound commands are deliberately unaffected: search, status and the rest
 * all wrap the same lancedb 0.39.0 Rust core whichever front end calls them, so
 * "selecting a backend" there would swap identical engines behind different wrappers.
 */
if (f["no-native"]) process.env.RELIC_NATIVE = "0";
else if (typeof f.native === "string") process.env.RELIC_NATIVE = f.native;

// ---- memory / pending -------------------------------------------------------
// Both functions already existed in query.ts with no way to call them. A query nobody
// can run is the same as a query that does not exist.
async function cmdMemory(f: Record<string, string | boolean>) {
  const scope = { dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
                  repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };
  const r = await memoryReport({ ...scope, memType: f["mem-type"] ? String(f["mem-type"]) : undefined,
                                 since: f.since ? String(f.since) : undefined,
                                 until: f.until ? String(f.until) : undefined });
  if (outFmt(f) === "json") { console.log(JSON.stringify(r, null, 2)); return; }
  console.log(`memories  ${fmt(r.total)} across ${r.shards} shards   ${r.ms} ms`);
  console.log(`  ${r.byType.map(b => `${b.type || "(untyped)"}=${b.n}`).join("  ")}`);
  console.log(`  with origin ${r.withOrigin}   joined ${r.joined}   orphaned ${r.orphaned}` +
              `   no origin ${r.total - r.withOrigin}`);
  if (r.perRepo.length) {
    console.log(`\n  repo                                      mem   transcripts  producing`);
    for (const x of r.perRepo.slice(0, Number(f.limit ?? 20)))
      console.log(`  ${x.repo.replace("github.com/", "").padEnd(40)} ${String(x.memories).padStart(4)}` +
                  `  ${String(x.transcripts).padStart(11)}  ${String(x.producing).padStart(9)}`);
  }
}

async function cmdPending(f: Record<string, string | boolean>) {
  const r = await pendingReport({
    dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
    repo: f.repo ? String(f.repo) : undefined, bank: f.bank ? String(f.bank) : undefined,
    corpus: f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null,
    since: f.since ? String(f.since) : undefined,
    // `--list` with no value means "a screenful", not "zero" — a bare flag parses as
    // boolean true, and Number(true) is 1, which would silently show one row.
    list: f.list === undefined ? 0 : (f.list === true ? 20 : Number(f.list)),
  });
  const pmode = outFmt(f);
  if (pmode === "json") { console.log(JSON.stringify(r, null, 2)); return; }
  if (pmode === "jsonl") { for (const x of r.files) console.log(JSON.stringify(x)); return; }
  if (pmode === "plain") {
    for (const x of r.files)
      console.log([x.sessionId, x.repo, x.bank, x.source + "/" + x.tier, x.state, x.path].join("\t"));
    return;
  }
  console.log(`found ${fmt(r.found)}  indexed ${fmt(r.indexed)}  missing ${fmt(r.missing)}  changed ${fmt(r.changed)}   ${r.scanMs} ms`);
  if (r.newestPendingMs !== null)
    console.log(`newest pending file: ${localDateTime(new Date(r.newestPendingMs).toISOString())}`);
  for (const g of r.groups)
    console.log(`  ${(g.source + "/" + g.tier).padEnd(30)} found ${String(g.found).padStart(6)}` +
                `  missing ${String(g.missing).padStart(6)}  changed ${String(g.changed).padStart(6)}`);

  if (r.files.length && f.tree) {
    /*
     * The same shape question as `session --tree`, asked of what is NOT indexed.
     *
     * A flat pending list is a column of near-identical absolute paths, and the thing
     * a reader actually wants is which RUN they belong to — ten files under one
     * wf_<run>/ is one workflow that has not been imported yet, not ten unrelated
     * gaps. Weight is bytes here, because an unindexed file has no event count: it
     * does not exist in the index at all.
     */
    const root = commonPrefix(r.files.map(x => x.path));
    const entries = r.files.map(x => ({
      path: x.path.startsWith(root) ? x.path.slice(root.length) : x.path,
      label: `${x.state} ${x.tier} ${fmt(x.size)}b`,
      weight: x.size,
    }));
    console.log(`\n${root}`);
    renderTree(buildTree(entries), "", Number(f.limit ?? 8), console.log, "b");
    console.log(`\n${fmt(r.files.length)} pending shown · missing ${fmt(r.missing)} · changed ${fmt(r.changed)}`);
    if (r.filesOmitted) console.log(`... and ${fmt(r.filesOmitted)} more pending (--list N)`);
    return;
  }

  if (r.files.length && f.paths) {
    /*
     * The full record, one file per two lines.
     *
     * The table below is scannable but lossy: it truncates the session id to 8
     * characters and drops the path entirely, so answering "which file exactly, and
     * where" meant piping --json through a script. A view someone has to rebuild by
     * hand belongs in the tool.
     */
    console.log(`\nnot indexed yet — newest first (repo read from each transcript's own cwd):\n`);
    for (const x of r.files) {
      const when = localDateTime(new Date(x.mtime * 1000).toISOString());
      console.log(`${when}  ${x.state.padEnd(7)} ${x.tier.padEnd(15)} ${x.sessionId || "(no session id)"}`);
      console.log(`          ${x.repo}  ·  bank ${x.bank}  ·  ${x.source}`);
      console.log(`          ${x.path}`);
    }
    if (r.filesOmitted) console.log(`\n... and ${fmt(r.filesOmitted)} more pending (--list N)`);
    return;
  }

  if (r.files.length) {
    console.log(`\nnot indexed yet — newest first (repo read from each transcript's own cwd):\n`);
    console.log(`  ${"when".padEnd(16)} ${"session".padEnd(10)} ${"state".padEnd(7)} ` +
                `${"bank".padEnd(22)} ${"source/tier".padEnd(26)} repo`);
    for (const x of r.files)
      console.log(`  ${localDateTime(new Date(x.mtime * 1000).toISOString()).padEnd(16)} ` +
                  `${(x.sessionId ? x.sessionId.slice(0, 8) : "-").padEnd(10)} ` +
                  `${x.state.padEnd(7)} ${x.bank.padEnd(22)} ` +
                  `${(x.source + "/" + x.tier).padEnd(26)} ${x.repo}`);
    if (r.filesOmitted) console.log(`  ... and ${fmt(r.filesOmitted)} more pending (--list N)`);
  } else if (f.list !== undefined && r.missing + r.changed === 0) {
    console.log(`\nnothing pending — every discovered file is in the index.`);
  }
}

if (!cmd || f.help) {
  console.log(`relic — per-repo LanceDB index of Claude Code + Codex session JSONL

  index   [--corpus ...] [--since 7d] [--repo SUBSTR] [--skip-noise] [--dry-run]
  search  <query> [--repo S] [--bank B] [--org S] [--project S] [--dir S] [--all-tiers] [--worktree S] [--path S] [--tier ...] [--source ...]
                  [--since 7d|2026-09-01] [--until DATE] [--limit N]
                  [--prose]  humans + assistant only — 80% of a transcript is tool traffic
                  [--role user|assistant|tool_use|tool_result|thinking]
  show    <file> --seq N [--before 2] [--after 2]
  session <id|prefix> [--repo S] [--bank B] [--tree]  resolve an id to its transcripts
                               --tree shows the SHAPE: which agents shared a workflow run
  chain   <id|prefix>          the session tree on one time axis — what ran in parallel
  read    <file> [--prose]     whole transcript as readable conversation, any format
  mcp                          run the MCP server on stdio (same lookups, for a model)
  now [--all] [--window 300]   what is running RIGHT NOW — this session, its live agents
  dig [N] [--deep] [--no-cache] session timeline as JSON — dig.py contract, all 3 tiers
  sessions [--repo S] [--bank B] [--since 24h] [--worktree S] [--count] [--limit 40]
  memory  [--mem-type T] [--bank B] [--limit 20]  Claude's own memory, joined to the
                               sessions that produced it — which had one, which had none
  pending [--corpus ...] [--since 1h] [--repo S] [--bank B] [--list N] [--paths]
                               on disk but not indexed: missing vs changed. --list N
                               names them — session id, repo, bank, newest first.
                               --paths adds the full session id and absolute path.
                               --tree groups them by directory — which RUN is missing.
  status  [--limit 15] [--bank B]
  sources                      what this machine has, and what is on/off
  skipped                      what --skip-noise dropped, and the proof
  trace   [--limit 10] [--cloud]  query log: who answers, what is dead, keyword cloud
  backend [--probe]            which engine answers what, and how fast here
  banks                        bank names on this machine
  shards  [--bank B] [--repo S] [--count]   the index layout

  --no-native        force the TypeScript scan (see: relic backend)
  --native PATH      use a specific relic-native binary
  --in-repo          write <ghq>/<org>/<repo>/.relic/ instead of ~/.relic
  --data-root PATH   explicit index location
  --json --jsonl --plain   machine output (or --format json|jsonl|plain)
                     plain = file<TAB>seq<TAB>repo<TAB>text, one per line

Sharded BANK first, then per repo ghq-style, under $HOME by default:
  ${defaultRoot()}/banks/<bank>/github.com/<org>/<repo>/

A bank is one whole source root (a Claude projects dir, codex, omp, memory).
--bank filters to one exactly; relic status prints the banks on this machine.

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
  const det = detect();
  for (const s of det)
    console.log(`  ${s.enabled ? "[on] " : "[off]"} ${s.key.padEnd(16)} ${s.present ? "present" : "MISSING"}  bank=${s.bank.padEnd(22)} ${s.path}\n         ${s.note}`);
  const banks = [...new Set(det.filter(s => s.enabled).map(s => s.bank))];
  console.log(`\n  ${banks.length} banks would be written: ${banks.join(" · ")}`);
  console.log("\nreal history that is NOT jsonl — needs a different reader:");
  for (const k of KNOWN_NON_JSONL) console.log(`  [--]  ${k.key.padEnd(16)} ${k.path}\n         ${k.note}`);
}
else if (cmd === "trace") {
  const cloud = Boolean(f.cloud);
  const dataRoot = (f["data-root"] as string) ?? null;
  // BARE repo keys, not shard keys: `top_repo` in the log is written bank-less (cli.ts
  // `show` uses repoKeyOf), so comparing against "<bank>/github.com/..." would report
  // every shard as "never produced a best hit".
  const shards = [...new Set(listShards(dataRoot, Boolean(f["in-repo"])).map(s => s.repo))];
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
else if (cmd === "read") {
  if (!pos[1]) { console.error("read needs a file path"); process.exit(1); }
  const { parserFor } = await import("./sources.js");
  const parsed = await parserFor(pos[1])(pos[1]);
  const wantRole = f.role as string | undefined;
  const prose = Boolean(f.prose);
  const rows = parsed.events.filter(e =>
    (!wantRole || e.role === wantRole) &&
    (!prose || e.role === "user" || e.role === "assistant" || e.role === "thinking" || e.role === "note"));

  const mode = outFmt(f);
  if (mode === "json")  { console.log(JSON.stringify({ file: pos[1], title: parsed.title, events: rows }, null, 2)); }
  else if (mode === "jsonl") { for (const e of rows) console.log(JSON.stringify(e)); }
  else if (mode === "plain") { for (const e of rows) console.log(`${e.seq}\t${e.role}\t${e.text.replace(/\s+/g, " ")}`); }
  else {
    if (parsed.title) console.log(`${parsed.title}\n`);
    for (const e of rows) {
      console.log(`#${String(e.seq).padStart(4)} ${e.role}${e.ts ? `  ${localDateTime(e.ts)}` : ""}`);
      console.log(e.text.replace(/^/gm, "  "));
      console.log();
    }
    console.log(`${rows.length} of ${parsed.events.length} events · ${pos[1]}`);
  }
}
else if (cmd === "now" || cmd === "live") await cmdNow(f);
else if (cmd === "backend") await cmdBackend(f);
else if (cmd === "banks") cmdBanks(f);
else if (cmd === "shards") cmdShards(f);
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
else if (cmd === "memory") await cmdMemory(f);
else if (cmd === "pending") await cmdPending(f);
else if (cmd === "status") await cmdStatus(f);
else { console.error(`unknown command: ${cmd}`); process.exit(1); }
