#!/usr/bin/env bun
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { discover, parseSince, type Found } from "./discover.js";
import { detect, KNOWN_NON_JSONL } from "./sources.js";
import { trace, readTrace, tracePath } from "./trace.js";
import { repoKeyOf, contextOf, cwdOfFile, shardDirFor, ghqRoot, defaultRoot, guardShardDir, listShards } from "./repo.js";

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
const nowISO = () => new Date().toISOString();

/** One store per repo, opened on first write. */
class Shards {
  private pool = new Map<string, LanceStore>();
  constructor(private dataRoot: string | null, private inRepo = false) {}
  async get(repoKey: string | null): Promise<LanceStore> {
    const key = repoKey ?? "_unresolved";
    let s = this.pool.get(key);
    if (!s) {
      const dir = shardDirFor(repoKey, this.dataRoot, this.inRepo);
      guardShardDir(dir);
      s = await LanceStore.open(dir);
      this.pool.set(key, s);
    }
    return s;
  }
  get size() { return this.pool.size; }
  keys() { return [...this.pool.keys()]; }
}

// ---- index -----------------------------------------------------------------
async function cmdIndex(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const inRepo = Boolean(f["in-repo"]);
  const only = f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null;
  const sinceMs = parseSince(f.since as string | undefined);

  const t0 = Date.now();
  const mode = [only ? only.join("+") : "all enabled sources",
                sinceMs ? `since ${new Date(sinceMs).toISOString().slice(0, 16)}` : "full history",
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

  const shards = new Shards(dataRoot, inRepo);

  // Each shard owns its own manifest, so the skip check needs the file's repo — which is
  // only knowable after parsing. Parsing is cheap relative to writing, so the order is:
  // parse -> route -> skip-or-write. The manifest still prevents the expensive half.
  const manifests = new Map<string, Map<string, { mtime: number; size: number }>>();
  let added = 0, skipped = 0, failed = 0, done = 0, filtered = 0;

  for (const file of found) {
    try {
      const p = await file.parser(file.path);
      const repoKey = repoKeyOf(p.cwd);

      // Authoritative filter: the session's own cwd, not the lossy directory name.
      if (repoFilter && !(repoKey ?? "").includes(repoFilter)) { filtered++; continue; }

      const shardKey = repoKey ?? "_unresolved";
      const ctx = contextOf(p.cwd);
      const store = await shards.get(repoKey);

      if (!manifests.has(shardKey)) manifests.set(shardKey, await store.manifest());
      const man = manifests.get(shardKey)!;
      const seen = man.get(file.path);
      if (seen && seen.mtime === file.mtime && seen.size === file.size) { skipped++; continue; }

      const events: EventRow[] = p.events.map(e => ({
        uid: e.uid, session_uuid: p.sessionUuid, file_path: file.path, repo_key: shardKey,
        seq: e.seq, role: e.role, ts: e.ts ?? "", text: e.text,
        source: file.source, tier: file.tier,
        worktree: ctx.worktree, cwd: p.cwd ?? "",
      }));

      if (seen) await store.deleteEventsOf(file.path);   // a shrinking file must not orphan rows
      await store.putEvents(events);
      await store.putSession({
        session_uuid: p.sessionUuid, file_path: file.path, repo_key: shardKey,
        project_dir: file.projectDir, tier: file.tier, source: file.source,
        cwd: p.cwd ?? "", model: p.model ?? "", worktree: ctx.worktree,
        workflow_run_id: file.workflowRunId ?? "", agent_id: file.agentId ?? "",
        file_mtime: file.mtime, file_size: file.size,
        line_count: p.lines, event_count: p.events.length, bad_lines: p.badLines,
        started_at: p.startedAt ?? "", ended_at: p.endedAt ?? "",
        description: p.description ?? "", imported_at: nowISO(),
      });
      await store.putFile({ file_path: file.path, repo_key: shardKey, mtime: file.mtime, size: file.size, imported_at: nowISO() });
      man.set(file.path, { mtime: file.mtime, size: file.size });
      added += events.length;
    } catch (err) {
      failed++;
      if (f.verbose) process.stderr.write(`  FAIL ${file.path}: ${String(err).slice(0, 160)}\n`);
    }
    if (++done % 100 === 0) {
      const pct = Math.round((done / found.length) * 100);
      const rate = done / ((Date.now() - t0) / 1000);
      const eta = rate > 0 ? Math.round((found.length - done) / rate) : 0;
      process.stderr.write(
        `\r  ${String(pct).padStart(3)}%  ${fmt(done)}/${fmt(found.length)} files` +
        `  ${fmt(added)} events  ${shards.size} shards` +
        `  ${rate.toFixed(0)}/s  eta ${eta}s   `);
    }
  }
  if (done >= 100) process.stderr.write("\r" + " ".repeat(96) + "\r");
  const tIdx = Date.now();
  let indexed = 0;
  for (const key of shards.keys()) {
    try { await (await shards.get(key === "_unresolved" ? null : key)).ensureFtsIndex(); indexed++; } catch {}
  }
  const idxSecs = ((Date.now() - tIdx) / 1000).toFixed(1);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const byTier = new Map<string, number>();
  for (const x of found) byTier.set(`${x.source}/${x.tier}`, (byTier.get(`${x.source}/${x.tier}`) ?? 0) + 1);

  console.log(`  scanned:     ${fmt(found.length + prefiltered)} files`);
  for (const [k, v] of [...byTier].sort((a, b) => b[1] - a[1]))
    console.log(`               ${String(fmt(v)).padStart(7)}  ${k}`);
  if (prefiltered) console.log(`  prefiltered: ${fmt(prefiltered)} (name did not match --repo, never opened)`);
  if (filtered)    console.log(`  other-repo:  ${fmt(filtered)} (parsed, cwd belongs elsewhere)`);
  console.log(`  unchanged:   ${fmt(skipped)} (mtime+size match, never re-read)`);
  console.log(`  imported:    ${fmt(done - skipped - filtered)} files -> ${fmt(added)} events`);
  if (failed) console.log(`  \u26A0 failed:    ${fmt(failed)} (re-run with --verbose to see why)`);
  console.log(`  shards:      ${shards.size} repo${shards.size === 1 ? "" : "s"}, ${indexed} fts index built in ${idxSecs}s`);
  console.log(`  wrote:       ${dataRoot ?? (inRepo ? "in-repo .relic/" : defaultRoot())} in ${secs}s`);
}

// ---- search ----------------------------------------------------------------
async function cmdSearch(q: string, f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const limit = Number(f.limit ?? 20);
  // --since accepts 7d / 12h / 30m / 2026-09-01; --until the same. Both normalise to
  // an ISO prefix so they compare against the stored ts directly.
  const toISO = (v: unknown, endOfDay = false): string | undefined => {
    if (!v) return undefined;
    const raw = String(v);
    const rel = parseSince(raw);
    if (rel && /^\d+[mhd]$/.test(raw)) return new Date(rel).toISOString();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + (endOfDay ? "T23:59:59Z" : "T00:00:00Z");
    return raw;
  };
  const sinceISO = toISO(f.since);
  const untilISO = toISO(f.until, true);

  let shards = listShards(dataRoot, Boolean(f["in-repo"]));
  if (f.repo) shards = shards.filter(s => s.key.includes(String(f.repo)));
  if (!shards.length) {
    const where = dataRoot ?? (Boolean(f["in-repo"]) ? `${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot());
    console.log(`no shards found in  ${where}\n`);
    console.log(`  index one first:   relic index --since 7d${dataRoot ? ` --data-root ${dataRoot}` : ""}`);
    if (!dataRoot) console.log(`  or point elsewhere: relic search ... --data-root /path/to/index`);
    return;
  }

  const hits: (EventRow & { repo: string })[] = [];
  let searched = 0;
  const t0 = performance.now();
  for (const s of shards) {
    try {
      const store = await LanceStore.open(s.dir);
      for (const h of await store.search(q, { limit, tier: f.tier as string, source: f.source as string,
        worktree: f.worktree as string, path: f.path as string, since: sinceISO, until: untilISO }))
        hits.push({ ...h, repo: s.key });
      searched++;
    } catch { /* a shard mid-write can throw; skip rather than abort the fan-out */ }
  }
  const ms = performance.now() - t0;

  const filters: Record<string, string> = {};
  for (const k of ["repo", "worktree", "path", "tier", "source"]) if (f[k]) filters[k] = String(f[k]);
  trace({
    ts: new Date().toISOString(), q, chars: [...q].length, filters,
    shards: searched, hits: hits.length, ms: Math.round(ms),
    top_repo: hits[0]?.repo ?? "", fts: true,
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

  if (!hits.length) { console.log(`no matches for ${q} across ${searched} shards (${ms.toFixed(0)} ms)`); return; }
  console.log(`${Math.min(hits.length, limit)} of ${hits.length} match(es) for ${q} · ${searched} shards · ${ms.toFixed(0)} ms\n`);
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

  const target = Number(f.seq ?? 1), before = Number(f.before ?? 2), after = Number(f.after ?? 2);
  const rl = createInterface({ input: createReadStream(path, "utf8") });
  let seq = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    seq++;
    if (seq < target - before) continue;
    if (seq > target + after) break;
    let role = "?", text = line.slice(0, 400);
    try {
      const rec = JSON.parse(line);
      role = rec.message?.role ?? rec.type ?? "?";
      const c = rec.message?.content ?? rec.payload?.content ?? rec.content;
      text = typeof c === "string" ? c : JSON.stringify(c ?? rec).slice(0, 600);
    } catch {}
    console.log(`${seq === target ? ">>" : "  "} #${seq} ${role}: ${String(text).replace(/\s+/g, " ").slice(0, 300)}`);
  }
}

// ---- sessions ----
async function cmdSessions(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const toISO = (v: unknown, end = false): string | undefined => {
    if (!v) return undefined;
    const raw = String(v);
    const rel = parseSince(raw);
    if (rel && /^\d+[mhd]$/.test(raw)) return new Date(rel).toISOString();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw + (end ? "T23:59:59Z" : "T00:00:00Z");
    return raw;
  };
  const since = toISO(f.since), until = toISO(f.until, true);

  let shards = listShards(dataRoot, Boolean(f["in-repo"]));
  if (f.repo) shards = shards.filter(s => s.key.includes(String(f.repo)));
  if (!shards.length) { console.log("no shards match"); return; }

  const rows: (SessionRow & { repo: string })[] = [];
  for (const sh of shards) {
    try {
      const store = await LanceStore.open(sh.dir);
      for (const r of await store.sessions({ since, until, worktree: f.worktree as string }))
        rows.push({ ...r, repo: sh.key });
    } catch { /* skip unreadable shard */ }
  }
  rows.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
  const limit = Number(f.limit ?? 40);
  const top = rows.slice(0, limit);

  const mode = outFmt(f);
  if (mode === "json")  { console.log(JSON.stringify({ total: rows.length, sessions: top }, null, 2)); return; }
  if (mode === "jsonl") { for (const r of top) console.log(JSON.stringify(r)); return; }
  if (mode === "plain") { for (const r of top) console.log([r.session_uuid, r.started_at, r.repo, r.worktree, r.event_count].join("\t")); return; }

  if (f.count) { console.log(`${rows.length} sessions`); return; }
  const events = rows.reduce((a, r) => a + Number(r.event_count ?? 0), 0);
  console.log(`${fmt(rows.length)} sessions · ${fmt(events)} events` +
    (since ? ` · since ${since.slice(0, 16)}` : "") + (f.repo ? ` · repo~${f.repo}` : "") + "\n");
  for (const r of top) {
    const wt = r.worktree ? `  [${r.worktree}]` : "";
    console.log(`${String(r.started_at).slice(0, 16)}  ${r.session_uuid.slice(0, 8)}  ${String(r.event_count).padStart(6)} ev  ${r.repo.replace("github.com/", "")}${wt}`);
    if (r.description) console.log(`    ${r.description.replace(/\s+/g, " ").slice(0, 96)}`);
  }
  if (rows.length > top.length) console.log(`\n... and ${rows.length - top.length} more (--limit N)`);
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

// ---- main ------------------------------------------------------------------
const { f, pos } = flags(process.argv.slice(2));
const cmd = pos[0];

if (!cmd || f.help) {
  console.log(`relic — per-repo LanceDB index of Claude Code + Codex session JSONL

  index   [--corpus ...] [--since 7d] [--repo SUBSTR] [--dry-run]
  search  <query> [--repo S] [--worktree S] [--path S] [--tier ...] [--source ...]
                  [--since 7d|2026-09-01] [--until DATE] [--limit N]
  show    <file> --seq N [--before 2] [--after 2]
  sessions [--repo S] [--since 24h] [--worktree S] [--count] [--limit 40]
  status  [--limit 15]
  sources                      what this machine has, and what is on/off
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
else if (cmd === "sessions") await cmdSessions(f);
else if (cmd === "status") await cmdStatus(f);
else { console.error(`unknown command: ${cmd}`); process.exit(1); }
