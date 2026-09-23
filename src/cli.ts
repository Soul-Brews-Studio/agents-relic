#!/usr/bin/env bun
import { homedir } from "node:os";
import { existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { LanceStore, type EventRow, type SessionRow } from "./store/lance.js";
import { discover, parseSince, type Found, type PathOverride } from "./discover.js";
import { detect, KNOWN_NON_JSONL, envHomes } from "./sources.js";
import { sourceKeys } from "./discover.js";
import { trace, readTrace, tracePath } from "./trace.js";
import { classify, logSkipped, readSkipped, skippedPath, logSkippedFiles, readSkippedFiles } from "./noise.js";
import { walkFailures } from "./unreadable.js";
import { renderChain } from "./chain.js";
import { buildTree, renderTree, commonPrefix } from "./tree.js";
import { buildReport, renderReport, type ReportRow } from "./report.js";
import { helpText } from "./help.js";
import { stripEnvelope } from "./types.js";
import { progress, clearLine } from "./progress.js";
import { flags } from "./flags.js";
import { isHarnessTurn, handoffBudget, isInboundTurn } from "./recap.js";
import { localDateTime, localTime, zoneOffset, dur, handoffStats, usableStamps } from "./time.js";
import { currentSession, liveSessions, treeFiles, activityBuckets, sparkline, humanAge, clockLabel } from "./live.js";
import { findSessions, buildLineage, renderLineage, lineageJSON, isClaudeProjectDir, shortId, type Lineage } from "./lineage.js";
import { findHermesSessions, buildHermesLineage, hermesOffNotes } from "./lineage-hermes.js";
import { dig as runDig, defaultProjectDirs } from "./dig.js";
import { Shards, importFiles, type ImportOpts, type ImportTally } from "./import.js";

// #37 — noise filtering is now ON by default: blob-shaped tool traffic (base64,
// hex, JWTs, minified JS — see noise.ts's longestUnbrokenRun) inflates FTS document
// frequencies for no benefit, and the rule has been auditable via `relic skipped`
// since it was introduced. `--keep-noise` is the escape hatch back to the old,
// unfiltered behaviour — nothing becomes unrecoverable, since the source JSONL on
// disk is untouched either way. `--skip-noise` still works as a (now redundant) way
// to ask for the default explicitly.
function wantSkipNoise(f: Record<string, string | boolean>): boolean {
  return !Boolean(f["keep-noise"]);
}
import { prune, pruneTotals, DEFAULT_MAX_DROP_PCT, type PrunePlan } from "./prune.js";
import { type Scope, semanticSearch, searchEvents, listSessions, resolveSession, chainOf, readAround, pickShards, toISO,
         statsOf, neighbours, nameOf, staleness, answerFreshness, memoryReport, pendingReport,
         groupByBank, maxISO, unindexedHint, degradedNote } from "./query.js";
import { sessionRecap } from "./recap.js";
import { embedShards, DEFAULT_OLLAMA } from "./embed.js";
import { scanLangs, recommend, renderLangs } from "./langs.js";
import { ephemeralNote, bankOfHit } from "./ephemeral.js";
import { repoIndex, resolveRepoKey, repoKeyOf, cwdOfFile, ghqRoot, defaultRoot, listShards } from "./repo.js";

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

/**
 * Validate `--source-path` before anything walks.
 *
 * Every failure here is one that would otherwise be SILENT: discover() skips a source
 * whose root does not exist, so a typo'd path, an unknown corpus name, or two corpora
 * all produce a clean "scanned 0 files" and a successful exit. That is the same shape
 * as the ghq.root bug — a feature that became a no-op and still printed a summary.
 */
function resolveSourcePath(f: Record<string, string | boolean>, only: string[] | null): PathOverride | null {
  const raw = f["source-path"];
  if (raw === undefined) return null;
  const path = String(raw);
  if (!only || only.length !== 1) {
    console.error("--source-path overrides ONE source's root, so it needs exactly one --corpus.");
    console.error("  e.g. relic index --corpus oracle-vault --source-path /path/to/repo/\u03C8");
    process.exit(1);
  }
  if (!sourceKeys().includes(only[0])) {
    console.error(`unknown corpus "${only[0]}" — see: relic sources`);
    process.exit(1);
  }
  if (!existsSync(path)) {
    console.error(`--source-path does not exist: ${path}`);
    console.error("  (discover skips a missing root silently, so this would have indexed nothing and exited 0)");
    process.exit(1);
  }
  return { key: only[0], path };
}

// ---- index -----------------------------------------------------------------
async function cmdIndex(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const inRepo = Boolean(f["in-repo"]);
  const skipNoise = wantSkipNoise(f);
  const only = f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null;
  const sinceMs = parseSince(f.since as string | undefined);
  const override = resolveSourcePath(f, only);

  const t0 = Date.now();
  const mode = [only ? only.join("+") : "all enabled sources",
                override ? `path=${override.path}` : null,
                sinceMs ? `since ${localDateTime(sinceMs)}` : "full history",
                f.repo ? `repo~${f.repo}` : null,
                f["dry-run"] ? "DRY RUN — no writes" : null].filter(Boolean).join(" · ");
  console.log(`\u{1F3FA} relic indexing  (${mode})`);
  let found = discover(only, sinceMs, override);
  const unreadable = walkFailures();

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
  logSkippedFiles(unreadable, dataRoot);

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
  if (unreadable.length)
    console.log(`  \u26A0 unreadable: ${fmt(unreadable.length)} path${unreadable.length === 1 ? "" : "s"} could not be read, ` +
                `nothing in ${unreadable.length === 1 ? "it" : "them"} indexed -> relic skipped --files`);
  if (filtered)    console.log(`  other-repo:  ${fmt(filtered)} (parsed, cwd belongs elsewhere)`);
  console.log(`  unchanged:   ${fmt(skipped)} (mtime+size match, never re-read)`);
  console.log(`  imported:    ${fmt(imported)} files -> ${fmt(added)} events`);
  if (tally.repaired) console.log(`  repaired:    ${fmt(tally.repaired)} files re-keyed — same-named transcripts had overwritten each other's events (#58)`);
  if (skipped_noise) console.log(`  noise:       ${fmt(skipped_noise)} events dropped (--keep-noise to disable) -> relic skipped`);
  if (failed) console.log(`  \u26A0 failed:    ${fmt(failed)} (re-run with --verbose to see why)`);
  console.log(`  shards:      ${shards.size} (bank,repo) pair${shards.size === 1 ? "" : "s"}` +
              `, ${tally.ftsBuilt} fts index built in ${idxSecs}s` +
              (tally.ftsFailed ? `  \u26A0 ${tally.ftsFailed} FAILED — those shards fall back to a slow LIKE scan` : ""));
  if (tally.ftsUpgraded)
    console.log(`  fts:         ${tally.ftsUpgraded} shard${tally.ftsUpgraded === 1 ? "" : "s"} rebuilt from \`simple\` to ICU`);
  if (tally.ftsSimple.length) {
    const n = tally.ftsSimple.length;
    console.log(`  \u26A0 fts:       ${n} shard${n === 1 ? "" : "s"} on the \`simple\` tokenizer — this LanceDB build has no ICU` +
                (tally.ftsNoIcu ? ` ("${/unknown base tokenizer [\w-]+/i.exec(tally.ftsNoIcu)?.[0] ?? tally.ftsNoIcu.slice(0, 80)}")` : ""));
    console.log(`               Thai substring search degraded on this shard${n === 1 ? "" : " (each of them)"}; a later run where ICU loads rebuilds it.`);
    for (const k of tally.ftsSimple.slice(0, 5)) console.log(`               ${k}`);
    if (n > 5) console.log(`               ... and ${n - 5} more — relic status lists them`);
  }
  console.log(`  wrote:       ${dataRoot ?? (inRepo ? "in-repo .relic/" : defaultRoot())} in ${secs}s`);

  // Opt-in, never implicit. The import just resolved every discovered file to its
  // shard, so pruning here costs one query per shard and no second parse pass.
  if (f.prune) {
    const maxDropPct = f["max-drop"] !== undefined ? Number(f["max-drop"]) : DEFAULT_MAX_DROP_PCT;
    const plan = await prune(tally, {
      apply: true, maxDropPct, force: Boolean(f.force), dataRoot, inRepo,
      sinceMs, repoFilter, unreadable: unreadable.length,
    });
    reportPrune(plan, maxDropPct);
  }
}

/**
 * Print a prune plan. Same renderer for the dry run and the applied one — the only
 * difference in the output is the verb, because the only difference in the run is
 * whether `delete` was called.
 */
/**
 * The drop set by filename, commonest first.
 *
 * A refusal that says only "72.7%" gives a human no way to decide whether --force is
 * safe. Measured on the live index: both refused `_unresolved` shards were 100% ONE
 * filename — journal.jsonl, the exact rows prune was built to remove — and the
 * percentage alone hid that completely.
 */
function dropShapes(paths: string[], top = 3): string {
  const by = new Map<string, number>();
  for (const p of paths) {
    const b = p.slice(p.lastIndexOf("/") + 1);
    by.set(b, (by.get(b) ?? 0) + 1);
  }
  return [...by].sort((a, b) => b[1] - a[1]).slice(0, top)
    .map(([b, n]) => `${fmt(n)}x ${b}`).join(", ") + (by.size > top ? `, +${by.size - top} more names` : "");
}

function reportPrune(plan: PrunePlan, maxDropPct: number) {
  if (plan.refused) {
    console.log(`\n  prune REFUSED — ${plan.refused}`);
    return;
  }
  const tot = pruneTotals(plan);
  const verb = plan.applied ? "removed" : "would remove";
  console.log(`\nprune (${plan.applied ? "APPLIED" : "dry run — nothing written"})`);
  for (const sh of plan.shards) {
    if (!sh.drop.length && !sh.blocked) continue;
    const name = `${sh.bank}/${sh.repo}`;
    if (sh.blocked) {
      console.log(`  \u26A0 ${name}`);
      console.log(`      SKIPPED — ${sh.blocked}. ${fmt(sh.drop.length)} of ${fmt(sh.indexed)} files.`);
      console.log(`      they are: ${dropShapes(sh.drop)}`);
      console.log(`      --force prunes it anyway; check the source root is fully readable first.`);
      continue;
    }
    console.log(`  ${name}`);
    console.log(`      ${verb} ${fmt(sh.drop.length)} of ${fmt(sh.indexed)} files (${sh.dropPct.toFixed(1)}%)` +
                `  ${fmt(sh.removed?.events ?? 0)} events  ${fmt(sh.removed?.sessions ?? 0)} sessions` +
                (sh.removed?.vectors ? `  ${fmt(sh.removed.vectors)} vectors` : ""));
    for (const d of sh.drop.slice(0, 3)) console.log(`        ${d}`);
    if (sh.drop.length > 3) console.log(`        … ${fmt(sh.drop.length - 3)} more`);
  }
  if (!tot.files && !tot.blocked) console.log(`  nothing to prune — every indexed file is still discoverable.`);
  console.log(`\n  ${verb}: ${fmt(tot.files)} file${tot.files === 1 ? "" : "s"}  ${fmt(tot.events)} events  ` +
              `${fmt(tot.sessions)} sessions  ${fmt(tot.vectors)} vectors  across ${tot.shards} shard${tot.shards === 1 ? "" : "s"}`);
  if (tot.blocked) console.log(`  \u26A0 ${tot.blocked} shard${tot.blocked === 1 ? "" : "s"} refused by the ${maxDropPct}% ceiling — see --force`);
  // "nothing to prune" and "never looked" are different facts. Only one means clean.
  if (plan.untouched) console.log(`  ${plan.untouched} shard${plan.untouched === 1 ? "" : "s"} on disk were not reached by this run — never considered`);
  if (!plan.applied && tot.files) console.log(`\n  to remove them:  relic prune --apply`);
}

// ---- prune -----------------------------------------------------------------
/**
 * Scan every source, then remove index rows for files discovery no longer yields.
 *
 * DRY BY DEFAULT. `--apply` is the only thing that deletes, and the preview it prints
 * comes from the same call with the flag flipped, so the number approved is the number
 * executed.
 *
 * This writes nothing on the way in — it is a full parse pass with `noWrite`, which
 * costs the same read as an index run over an unchanged corpus and adds no rows. Use
 * `relic index --prune` to do both in one pass when you were indexing anyway.
 */
async function cmdPrune(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const inRepo = Boolean(f["in-repo"]);
  const apply = Boolean(f.apply);
  const maxDropPct = f["max-drop"] !== undefined ? Number(f["max-drop"]) : DEFAULT_MAX_DROP_PCT;
  const only = f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null;

  // Gate 1 is checked by pruneRefusal against the run, but --since/--repo would also
  // silently change WHAT WAS SCANNED. Reject them here so the scan never happens.
  if (f["source-path"] !== undefined) {
    console.error("prune cannot take --source-path — an overridden root is a different population,");
    console.error("so every file under the source's REAL root would look deleted.");
    process.exit(1);
  }
  if (f.since || f.repo) {
    console.error("prune cannot take --since or --repo — a narrowed scan makes every file outside it look deleted.");
    console.error("prune always scans in full; use --corpus to limit which BANKS are eligible.");
    process.exit(1);
  }
  if (!Number.isFinite(maxDropPct) || maxDropPct < 0 || maxDropPct > 100) {
    console.error(`--max-drop must be a percentage between 0 and 100 (got ${String(f["max-drop"])})`);
    process.exit(1);
  }

  const t0 = Date.now();
  process.stderr.write(`\u{1F3FA} relic prune  (${only ? only.join("+") : "all enabled sources"} · ` +
                       `${apply ? "APPLY — rows will be deleted" : "dry run"} · ceiling ${maxDropPct}%)\n`);
  const found = discover(only, null);
  const unreadable = walkFailures().length;
  const tally = await importFiles(found, { dataRoot, inRepo, noWrite: true, progress: true,
                                          verbose: Boolean(f.verbose) }, t0);
  clearLine();

  console.log(`  scanned:     ${fmt(found.length)} files -> ${tally.seen.size} shards reached`);
  if (tally.failed) console.log(`  \u26A0 failed:    ${fmt(tally.failed)} (re-run with --verbose to see why)`);
  if (unreadable) console.log(`  \u26A0 unreadable: ${fmt(unreadable)} path${unreadable === 1 ? "" : "s"} (named on stderr)`);

  const plan = await prune(tally, { apply, maxDropPct, force: Boolean(f.force),
                                    dataRoot, inRepo, sinceMs: null, repoFilter: null, unreadable });
  reportPrune(plan, maxDropPct);
  console.log(`  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (plan.refused) process.exit(1);
}

// ---- search ----------------------------------------------------------------
/*
 * NO ARGUMENT MEANS THE SESSION BEFORE THIS ONE — the same rule `tail` uses.
 *
 * `relic tail` needs no id because the question "what was I just doing" is asked
 * from inside a session that already knows where it is. `recap` is the same
 * question with a different answer shape, and it was the only one still demanding
 * an id, which broke the obvious pairing:
 *
 *   relic tail -n 20 --role user   # what the human asked
 *   relic recap                    # what came of it
 *
 * One difference is real and is NOT papered over: tail reads the transcript from
 * disk, recap reads the index. A session that ended seconds ago is in the file and
 * not yet in the index, so a resolved id can still miss — the error below says so
 * rather than reporting the session as nonexistent.
 */
async function recapTarget(arg: string | undefined): Promise<string> {
  if (arg) return arg;
  const prev = await previousSessionFile(process.cwd());
  if (!prev) noEarlierSession(process.cwd());
  // STDERR, not stdout. This banner says which session was resolved — a diagnostic,
  // not data. On stdout it lands inside `--json` output and makes it unparseable:
  // `relic recap --json | jq` failed with "Invalid numeric literal" because the first
  // line was an arrow. Found by piping the new default into jq.
  console.error(`\u2190 ${shortId(prev.id)}  (newest session here that is not this one)`);
  return prev.id;
}

/** Nothing earlier in this directory: point at the machine-wide view, and at Hermes data left switched off. */
function noEarlierSession(cwd: string): never {
  console.error(`no earlier session found for ${cwd}`);
  console.error(`  relic now --all   lists what is running, anywhere`);
  for (const note of hermesOffNotes()) console.error(`  ${note}`);
  process.exit(1);
}

/*
 * `relic probe` — what WOULD the noise rules drop, without writing an index.
 *
 * This existed first as a throwaway script in /tmp, written to check a PR that
 * widened the binary-blob rule. It found that the widened rule flagged 678 events
 * where the old one flagged 14, and that 664 of the difference were deep file paths,
 * one-line JSON tool results and `rg` command lines — content the index exists to
 * find. The PR's own tests were green throughout; only real data showed it.
 *
 * A check that can decide that belongs in the tool, not in /tmp. Every future change
 * to noise.ts should be answerable with one command against real transcripts:
 * how many events does each rule claim, and what do its catches actually look like?
 */
async function cmdProbe(f: Record<string, string | boolean>) {
  const { discover, parseSince } = await import("./discover.js");
  const { classify } = await import("./noise.js");
  const corpus = f.corpus ? String(f.corpus).split(",") : ["claude-live"];
  const files = Number(f.files ?? 40);
  const samples = Number(f.samples ?? 3);
  const chars = Number(f.chars ?? 110);
  const repo = f.repo ? String(f.repo).toLowerCase() : null;

  let found = discover(corpus, parseSince(f.since as string | undefined));
  if (repo) found = found.filter(x => x.path.toLowerCase().includes(repo));
  // Newest first: a rule regression shows up in what the machine is producing NOW,
  // not in the oldest transcripts on disk.
  found.sort((a, b) => b.mtime - a.mtime);
  const take = files > 0 ? found.slice(0, files) : found;
  if (!take.length) { console.error(`no files matched (corpus=${corpus.join(",")}${repo ? ` repo~${repo}` : ""})`); process.exit(1); }

  const { parserFor } = await import("./sources.js");
  let events = 0, skipped = 0;
  const byRule = new Map<string, number>();
  const shown = new Map<string, string[]>();
  for (const x of take) {
    let parsed; try { parsed = await parserFor(x.path)(x.path); } catch { continue; }
    for (const e of parsed.events) {
      events++;
      const v = classify(e.text, e.role);
      if (!v.skip) continue;
      skipped++;
      byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
      const list = shown.get(v.rule) ?? [];
      if (list.length < samples) { list.push(`[${e.role}] ${e.text.replace(/\s+/g, " ").slice(0, chars)}`); shown.set(v.rule, list); }
    }
  }

  if (outFmt(f) === "json") {
    console.log(JSON.stringify({ files: take.length, events, skipped,
      rules: [...byRule].map(([rule, n]) => ({ rule, n, pct: +(n / events * 100).toFixed(2), samples: shown.get(rule) ?? [] })) }, null, 2));
    return;
  }
  console.log(`probe  ${fmt(take.length)} files · ${fmt(events)} events · ${fmt(skipped)} would be skipped ` +
              `(${(skipped / Math.max(1, events) * 100).toFixed(1)}%)\n`);
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${rule.padEnd(20)} ${String(fmt(n)).padStart(7)}  ${(n / events * 100).toFixed(2)}%`);
    // The samples are the point. A count cannot tell you whether a rule is eating
    // content; reading four of its catches can, in about ten seconds.
    for (const x of shown.get(rule) ?? []) console.log(`      ${x}`);
    console.log("");
  }
  console.log(`  read from disk, not the index — nothing was written.`);
}

async function cmdRecap(id: string, f: Record<string, string | boolean>) {
  const r = await sessionRecap(id, {
    dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
    repo: f.repo ? String(f.repo) : undefined, bank: f.bank ? String(f.bank) : undefined,
    limit: f.limit ? Number(f.limit) : undefined,
    allTiers: Boolean(f["all-tiers"]),
    chars: f.chars ? Number(f.chars) : undefined,
  });
  if (!r) {
    // recap reads the INDEX, so "no match" also covers "ran too recently to be in it".
    // A Hermes id names a different corpus, and indexing claude-live would not add it.
    const corpus = findHermesSessions(id).length ? "hermes" : "claude-live";
    console.error(`no session matched ${id}`);
    console.error(`  if it only just ran, it is in the file but not the index yet:`);
    console.error(`  relic index --corpus ${corpus}    (or: relic tail ${id}, which reads the file)`);
    process.exit(1);
  }
  if (outFmt(f) === "json") { console.log(JSON.stringify(r, null, 2)); return; }

  console.log(`${r.name}`);
  console.log(`${r.sessionUuid}  ·  ${r.repo}${r.gitBranch ? `  ·  ${r.gitBranch}` : ""}`);
  console.log(`${localDateTime(r.startedAt)} → ${localDateTime(r.endedAt)}  ·  ` +
              `${fmt(r.transcripts)} transcripts · ${fmt(r.events)} ev${r.model ? `  ·  ${r.model}` : ""}`);
  console.log(`  ${r.roles.map(x => `${x.role} ${fmt(x.n)}`).join(" · ")}`);

  if (r.asked.length) {
    const trimmed = r.askedTotal - r.asked.length;
    console.log(`\nWHAT WAS ASKED  (last ${fmt(r.asked.length)} of ${fmt(r.askedTotal)} turns` +
                (r.askedOmitted ? `, ${fmt(r.askedOmitted)} harness turns omitted` : "") + `)\n`);
    for (const t of r.asked) console.log(`  ${localDateTime(t.ts).slice(11)}  ${t.text}`);
    /*
     * SAY HOW TO GET THE REST, IN A FORM THAT CAN BE RUN.
     *
     * The reader of a recap is usually a model, and a truncated list it cannot widen
     * is worse than no list — it will either treat 20 turns as the whole session or
     * burn a turn asking the human how to see more. One runnable line closes both.
     * Printed only when something was actually withheld.
     */
    if (trimmed > 0) {
      const id = r.sessionUuid.slice(0, 8);
      console.log(`\n  ${fmt(trimmed)} earlier turns not shown.`);
      console.log(`    relic recap ${id} --limit 60     more`);
      console.log(`    relic recap ${id} --limit 0      all of them`);
      console.log(`    relic tail  ${id} -n 20 --handoff  the same turns WITH my replies, for a /new`);
    }
  } else if (r.askedOmitted) {
    // Saying WHY it is empty matters: "no turns" and "every turn was boilerplate" are
    // different facts and only one of them means the session had no human input.
    console.log(`\nWHAT WAS ASKED  —  none; all ${fmt(r.askedOmitted)} user turns were harness boilerplate`);
  }

  if (r.tools.length) {
    console.log(`\nWHAT RAN\n`);
    console.log(`  ${r.tools.map(t => `${t.name} ${fmt(t.n)}`).join(" · ")}`);
  }
  if (r.files.length) {
    console.log(`\nFILES EDITED\n`);
    for (const x of r.files) console.log(`  ${String(x.n).padStart(3)}x  ${x.path}`);
  }
  if (r.endedWith) console.log(`\nENDED WITH\n\n  ${r.endedWith}`);
}

async function cmdSemantic(q: string, f: Record<string, string | boolean>,
                           scope: Scope, limit: number) {
  let r;
  try {
    r = await semanticSearch(q, {
      ...scope, limit,
      overfetch: f.overfetch ? Number(f.overfetch) : undefined,
      tier: f.tier as string, role: f.role as string, source: f.source as string,
      since: f.since as string, until: f.until as string,
      device: f.device ? String(f.device) : undefined,
      session: f.session ? String(f.session) : undefined,
      allTiers: Boolean(f["all-tiers"] || f.tier),
    });
  } catch (e) {
    // "no vectors here" is a usage answer, not a stack trace — the message already
    // names the command that fixes it.
    console.error(String(e instanceof Error ? e.message : e));
    process.exit(1);
  }

  const mode = outFmt(f);
  if (mode === "json") { console.log(JSON.stringify(r, null, 2)); return; }
  if (mode === "jsonl") { for (const h of r.hits) console.log(JSON.stringify(h)); return; }
  if (mode === "plain") {
    for (const h of r.hits) console.log([h.file_path, h.seq, h.repo, h.text.replace(/\s+/g, " ")].join("\t"));
    return;
  }

  console.log(`${r.hits.length} semantic match(es) for ${q} · ${r.embedded} embedded shard(s)` +
              ` · ${r.ms} ms (query embed ${r.queryMs} ms)`);
  console.log(`model ${r.model}   score = cosine, 1.000 is identical`);
  // The silent-zero guard: a scope that is mostly unembedded returns few hits for a
  // reason that has nothing to do with the query, and saying so costs one line.
  if (r.unembedded)
    console.log(`\n  ⚠ ${r.unembedded} of ${r.available} scoped shards hold NO vectors and were not searched.` +
                `\n    \`relic index\` never writes them — see \`relic embed --dry-run\`.`);
  console.log("");
  for (const h of r.hits) {
    const score = Number((h as any)._score ?? 0).toFixed(3);
    const dup = Number((h as any)._dupes ?? 0);
    console.log(`${score}  ${h.repo}  ${h.source}/${h.tier}  ${h.role}  ${h.ts}` +
                (dup ? `   (+${dup} identical cop${dup === 1 ? "y" : "ies"} elsewhere)` : ""));
    console.log(`  ${h.text.replace(/\s+/g, " ").trim().slice(0, 220)}`);
    const eph = ephemeralNote(h.text, bankOfHit(h.repo));
    if (eph) console.log(eph);
    console.log(`  -> show ${h.file_path} --seq ${h.seq}\n`);
  }
}

async function cmdSearch(q: string, f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const limit = Number(f.limit ?? 20);
  const scope = { dataRoot, inRepo: Boolean(f["in-repo"]), repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };

  if (!pickShards(scope).length) {
    const where = dataRoot ?? (Boolean(f["in-repo"]) ? `${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot());
    /*
     * "NOT INDEXED" AND "NO MATCHES" ARE DIFFERENT FACTS, and this message covered
     * both. The narrower the filter, the likelier it selects a slice that is entirely
     * un-indexed — and the more authoritative the empty answer looks.
     */
    const named = ["repo", "bank", "worktree"].filter(k => f[k]).map(k => `--${k} ${f[k]}`).join(" ");
    console.log(`no shards ${named ? `match ${named}` : `found`} in  ${where}\n`);
    if (named) {
      console.log(`  This is NOT "no matches" — nothing for that filter is in the index at all.`);
      console.log(`  Check what is on disk but unindexed:   relic pending${f.repo ? ` --repo ${f.repo}` : ""}`);
    }
    console.log(`  index one first:   relic index --since 7d${dataRoot ? ` --data-root ${dataRoot}` : ""}`);
    if (!dataRoot) console.log(`  or point elsewhere: relic search ... --data-root /path/to/index`);
    return;
  }

  /*
   * --semantic is a SEPARATE MODE, not a re-ranking of the lexical one.
   *
   * Measured on this corpus: known-item FTS 0.890 MRR@20 vs 0.600, and the vectors add
   * one query in 200 to what FTS already finds; paraphrase flips it, 0.140 vs 0.046.
   * RRF fusion lost at every k in both directions, so blending them is not on offer —
   * the caller picks the regime, because the caller knows whether they are recalling a
   * phrase or describing an idea, and a classifier would be guessing at that.
   */
  if (f.semantic) { await cmdSemantic(q, f, scope, limit); return; }

  const { hits, shards: searched, ms, generic, degraded } = await searchEvents(q, {
    ...scope, limit,
    tier: f.tier as string, source: f.source as string, worktree: f.worktree as string,
    path: f.path as string, role: f.role as string, prose: Boolean(f.prose),
    org: f.org as string, project: f.project as string, dir: f.dir as string,
    since: f.since as string, until: f.until as string,
    allTiers: Boolean(f["all-tiers"] || f.tier),
    warnGeneric: !f["no-warn"],
  });

  const filters: Record<string, string> = {};
  for (const k of ["repo", "worktree", "path", "tier", "source"]) if (f[k]) filters[k] = String(f[k]);
  trace({
    ts: new Date().toISOString(), q, chars: [...q].length, filters,
    shards: searched, hits: hits.length, ms, // strip the bank — the trace log keys on the bare repo
            top_repo: (hits[0]?.repo ?? "").replace(/^[^/]+\//, ""), fts: true,
  }, dataRoot);

  /*
   * ACTIONABLE, NOT JUST "your query is generic" — names the rarest term the user
   * already typed (so they know which word to search alone) and lists the ways out.
   * stderr, so `--json`/`--jsonl`/`--plain` piped elsewhere stay uncontaminated;
   * never blocks the search or reorders hits — see query.ts for the measurements.
   */
  if (generic?.warn) {
    console.error(`\n  ⚠ generic query — every term is common across this corpus, so BM25 cannot` +
                  ` isolate one session (${generic.terms.map(t => `${t.term}=${Math.round(t.df * 100)}%`).join(", ")}).`);
    console.error(`    Looking for ONE specific session? Search "${generic.rarest}" alone — it is` +
                  ` the rarest of your terms — or a more unique literal still: an id, filename, error string.`);
    console.error(`    Or narrow the scope: --repo/--since/--worktree.  Or try --semantic for a paraphrase.`);
    console.error(`    Suppress this warning: --no-warn`);
  }

  // `--limit 0` (and negative) means "all", the same idiom recap teaches — so show every
  // hit the store returned rather than slicing to nothing. The store already unbounded the
  // query for limit <= 0 (#94); this keeps the CLI's own slice/count in agreement.
  const top = limit > 0 ? hits.slice(0, limit) : hits;
  const mode = outFmt(f);

  if (mode === "json") {
    console.log(JSON.stringify({ query: q, shards: searched, ms: Math.round(ms), total: hits.length,
                                 degraded: degraded ?? [], hits: top }, null, 2));
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

  const lossy = degradedNote(degraded, searched);
  if (!hits.length) {
    console.log(`no matches for ${q} across ${searched} shards (${ms} ms)`);
    if (lossy) console.log(`  ${lossy}`);
    return;
  }
  const narrowed = !f["all-tiers"] && !f.tier;
  /*
   * HOW OLD IS THE INDEX BEHIND THIS ANSWER.
   *
   * A ranked list from a stale index is worse than an empty one — confident,
   * relevant-looking, and silently scoped to whatever happened to be indexed. Scoped
   * to the shards that actually produced hits: that is the relevant population, and
   * freshness() full-scans two columns per shard (9.1 ms measured), so asking all
   * 1,136 would cost 10.3 s against a 1 s search.
   */
  const byKey = new Map(pickShards(scope).map(sh => [sh.key, sh.dir]));
  const fresh = await answerFreshness(
    [...new Set(top.map(h => byKey.get(h.repo)).filter(Boolean) as string[])]);
  const age = fresh ? `  ·  indexed ${humanAge(fresh.ageSec)} ago` : "";
  console.log(`${top.length} of ${hits.length} match(es) for ${q} · ${searched} shards · ${ms} ms${age}` +
    (narrowed ? `  ·  main sessions only — add --all-tiers for subagent/workflow work` : ""));
  if (lossy) console.log(`  ${lossy}`);
  // Loud past a day: at that point "no hits from repo X" usually means "not indexed".
  if (fresh && fresh.ageSec > 86_400) {
    // NOT `--corpus claude-live`: the stale shards may be any bank, and naming the
    // wrong corpus sends the reader to re-index something that was already current.
    const scoped = [f.repo ? `--repo ${f.repo}` : "", f.bank ? `--bank ${f.bank}` : ""].filter(Boolean).join(" ");
    console.log(`  \u26A0 the shards that answered were last indexed ${humanAge(fresh.ageSec)} ago —` +
                ` newer sessions are NOT in these results.`);
    console.log(`     relic index${scoped ? ` ${scoped}` : ""}   ·   relic status  names which bank is behind`);
  }
  console.log("");
  for (const h of top) {
    const i = h.text.toLowerCase().indexOf(q.toLowerCase());
    const snip = i < 0 ? h.text.slice(0, 160) : h.text.slice(Math.max(0, i - 60), i + q.length + 80);
    const wt = h.worktree ? `  [${h.worktree}]` : "";
    console.log(`${h.repo.replace("github.com/", "")}${wt}  ${h.source}/${h.tier}  ${h.role} ${h.ts}`);
    console.log(`  ...${snip.replace(/\s+/g, " ").trim()}...`);
    // Flagged against the WHOLE event text, not the 160-char snippet — the path that
    // matters is usually a tool's output line, not the part that matched the query.
    const eph = ephemeralNote(h.text, bankOfHit(h.repo));
    if (eph) console.log(eph);
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
    top_repo: resolveRepoKey(await cwdOfFile(path)) ?? "",
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
    ...scope, noIndex: Boolean(f["no-index"]), skipNoise: wantSkipNoise(f),
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

// ---- tail ------------------------------------------------------------------
/**
 * The last N turns of a session — the thing `read | tail` was being used for.
 *
 * Three commands nearly did this and none of them did:
 *   recap <id>        a SUMMARY — what was asked, what ran, how it ended
 *   read  <file>      the WHOLE transcript, and it needs a path, not an id
 *   show  <file>      raw JSON around one seq, and you must know the last seq
 *
 * So the working recipe was two commands and a pipe:
 *     F=$(relic session <id> --plain | head -1); relic read "$F" --prose | tail -40
 *
 * READS THE FILE, NEVER THE INDEX. "What was I just doing" is the one question where
 * a stale answer is worst, and the index is always at least one run behind the live
 * session — measured while building this, the current turn was in the file and not in
 * the index. That is also why no staleness warning is needed here.
 *
 * HARNESS TURNS ARE STRIPPED BY DEFAULT, reusing recap's filter. The user channel is
 * not the human: measured on the session this was built against, 55 of 63 user-channel
 * turns were the tooling describing itself. An unfiltered "last 10 turns" is mostly
 * slash-command expansion and system reminders — it answers the wrong question while
 * looking like it answered the right one.
 */
/**
 * The session BEFORE this one, in this directory — no id required.
 *
 * A fresh session cannot be handed its predecessor's id: the whole point of /new is
 * that nothing carries over. So the recovery prompt must not contain an id, or it
 * goes stale the moment it is used once.
 *
 * FILESYSTEM, NOT THE INDEX — the index is always at least one run behind a live session.
 * Ranked by last event, not mtime: a metadata-only rewrite must not resurrect an idle one (#67).
 *
 * The current session is excluded by id from the host env when it is set, and by
 * "youngest file" when it is not — a brand new session has usually already flushed a
 * line by the time a human types, so without the exclusion `tail` would hand you your
 * own empty transcript.
 */
async function previousSessionFile(cwd: string): Promise<{ file: string; id: string } | null> {
  const { encodeProjectDir, sessionIdFromEnv, liveRoots, rankByLastEvent } = await import("./live.js");
  const { readdirSync, statSync } = await import("node:fs");
  const { join } = await import("node:path");
  const me = sessionIdFromEnv()?.id ?? "";
  const enc = encodeProjectDir(cwd);
  const found: { file: string; id: string; mtime: number }[] = [];
  for (const root of liveRoots()) {
    const dir = join(root, enc);
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".jsonl")) continue;
        const id = name.slice(0, -6);
        if (me && id.startsWith(me.slice(0, 8))) continue;      // never my own transcript
        try { found.push({ file: join(dir, name), id, mtime: statSync(join(dir, name)).mtimeMs }); } catch {}
      }
    } catch { /* root without this project */ }
  }
  const ranked = rankByLastEvent(found.map(x => ({ ...x, path: x.file, mtimeMs: x.mtime })), 8);

  /*
   * HERMES HAS NO FILE IN THAT DIRECTORY (#100). Its sessions are rows in state.db, each
   * carrying its own cwd and its own event clock — the newest active message — so they
   * join the SAME ranking instead of being tried only when the transcripts come up
   * empty. The newest session is the answer, whichever host wrote it.
   */
  const { hermesSessionsIn } = await import("./live-hermes.js");
  const cands = [
    ...ranked.map(c => ({ file: c.file, id: c.id, at: c.lastEventMs ?? c.mtimeMs })),
    ...hermesSessionsIn(cwd).map(h => ({ file: h.path, id: h.id, at: h.lastMs })),
  ].sort((a, b) => b.at - a.at);

  /*
   * NEWEST IS NOT THE SAME AS WORTH READING.
   *
   * Measured here: the newest non-self transcript in this directory was `b658931d`,
   * a two-event stub — one "ok" and one "Ready. What task?". It is a fork point, not
   * a session, and handing it back as "what happened last time" is worse than
   * refusing, because it looks like an answer.
   *
   * So: newest first, but skip anything with no human turn left after the harness
   * filter. Parsing stops at the first real hit, so the normal case costs one parse.
   */
  const { parserFor } = await import("./sources.js");
  for (const c of cands.slice(0, 8)) {
    try {
      const p = await parserFor(c.file)(c.file);
      const human = p.events.some(e => e.role === "user" && !isHarnessTurn(e.text));
      if (human && p.events.length > 2) return { file: c.file, id: c.id };
    } catch { /* unreadable: try the next */ }
  }
  return cands[0] ?? null;      // nothing substantial — hand back the newest and say so
}

/*
 * The handoff block. One header carrying everything the next session would otherwise
 * have to compute, then the conversation with nothing between the lines.
 *
 * BOTH ROLES, ASYMMETRICALLY TRIMMED — and that asymmetry is the whole design.
 *
 * Human-only was the first version and it loses the thing it was built to carry. Half
 * this human's turns are "go", "gogogo", "merge all", "ok this cool!" — each one a
 * decision ABOUT a proposal that is not in the block. Read alone they are noise; beside
 * the line they answer they are the entire plot. So the assistant comes back — its LAST
 * word after each human turn, which is the conclusion rather than the "let me check
 * that" the first one would be. The chain then reads both ways: under a human turn is
 * what came of it, and above a human turn is what it was answering.
 *
 * It comes back SMALL. The assistant's turn is context for the human's, not content in
 * its own right — the next session is about to produce its own answers and does not
 * need this one's at length. Human turns get the full budget, assistant turns get
 * roughly half, which is enough to recognise a proposal and not enough to drown it.
 *
 * Gaps are measured on the HUMAN turns only. Interleaving assistant timestamps would
 * halve every gap and report a calm supervised day as frantic focus.
 *
 * MEDIAN and MAX, never mean. One overnight gap drags a mean so far that a hard-focus
 * session and an all-day supervised one report the same number — the median survives
 * the outlier, and the max IS the outlier, named.
 */
function printHandoff(title: string | undefined, tail: { role: string; ts?: string | null; text: string }[],
                      total: number, chars: number) {
  const humans = tail.filter(e => e.role === "user");
  const stamps = usableStamps(humans.map(e => e.ts));
  const st = handoffStats(stamps);

  if (title) console.log(title);
  const counts = `${humans.length} human turn${humans.length === 1 ? "" : "s"} of ${fmt(total)}`;
  if (st) {
    // Drop the repeated date on the end ONLY when it is the same day. A 30-hour
    // session printing "22:34 → 04:31" reads as six hours, and the span beside it
    // then looks like a bug rather than the point.
    const a = localDateTime(st.firstMs), b = localDateTime(st.lastMs);
    const end = a.slice(0, 10) === b.slice(0, 10) ? b.slice(11) : b;
    console.log(`${counts}  ·  ${a} → ${end}  ·  ${dur(st.spanMs)} span  ·  ` +
                `median gap ${dur(st.medianGapMs)}  ·  longest ${dur(st.maxGapMs)}`);
  } else if (stamps.length === 1) {
    // One turn has no span to report, but it IS dated, and a handoff block the next
    // session pastes as its first prompt should say when the work it describes happened.
    // Saying "no usable timestamps" here reads as a damaged transcript; on a host that
    // opens a session per inbound message, single-turn sessions are the normal shape.
    console.log(`${counts}  ·  ${localDateTime(stamps[0])}`);
  } else {
    console.log(`${counts}  ·  no usable timestamps`);
  }
  console.log("");

  for (const e of tail) {
    // A channel envelope is ~180 chars of routing before a word the human typed.
    const t = (e.role === "user" ? stripEnvelope(e.text) : e.text).replace(/\s+/g, " ").trim();
    if (!t) continue;
    const cut = handoffBudget(e.role, chars);
    const body = t.length > cut ? t.slice(0, cut) + " …" : t;
    // The human unmarked at the margin, the assistant indented under it: the block
    // reads as what was asked, with what it was answering underneath.
    console.log(e.role === "user" ? `  ${body}` : `      · ${body}`);
  }
}

async function cmdTail(target: string, f: Record<string, string | boolean>) {
  const n = Number(f.n ?? f.limit ?? 10);
  const chars = f.chars !== undefined ? Number(f.chars) : 0;      // 0 = whole turn
  const scope = { dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
                  repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };

  // A path is a path; anything else is an id to resolve. The index is used ONLY to
  // turn an id into a filename — never to supply the turns.
  let file = target;
  if (!target || target === "--last") {
    const prev = await previousSessionFile(process.cwd());
    if (!prev) noEarlierSession(process.cwd());
    file = prev.file;
    // STDERR, not stdout. This banner says which session was resolved — a diagnostic,
    // not data. On stdout it lands inside `--json` output and makes it unparseable:
    // `relic recap --json | jq` failed with "Invalid numeric literal" because the first
    // line was an arrow. Found by piping the new default into jq.
    console.error(`\u2190 ${shortId(prev.id)}  (newest session here that is not this one)`);
  } else if (!target.includes("/")) {
    const res = await resolveSession(target, scope, { noIndex: true } as any).catch(() => null) as any;
    const rows: any[] = res?.rows ?? [];
    if (rows.length) {
      // The PARENT transcript: a subagent's tail answers what an agent said to itself.
      const parent = rows.find((r: any) => r.tier === "session") ?? rows[0];
      file = String(parent.file_path);
    } else {
      // Not in the index. A Hermes id reads straight from its state.db, as lineage does —
      // `now --all` lists live Hermes sessions, and a session it lists must be tailable (#100).
      const hermes = findHermesSessions(target);
      if (hermes.length > 1) {
        console.error(`${target} matches ${hermes.length} Hermes sessions — give more of the id:`);
        for (const h of hermes.slice(0, 10)) console.error(`  ${h.id}  ${h.db}`);
        process.exit(1);
      }
      if (!hermes.length) {
        console.error(`no session matches ${target}`);
        console.error(`  relic now --all   lists what is running; relic report --since 7d  what ran lately`);
        for (const note of hermesOffNotes()) console.error(`  ${note}`);
        process.exit(1);
      }
      file = `${hermes[0].db}#${hermes[0].id}`;
    }
  }

  const { parserFor } = await import("./sources.js");
  let parsed;
  try { parsed = await parserFor(file)(file); }
  catch (e) { console.error(`cannot read ${file}: ${String(e).slice(0, 160)}`); process.exit(1); }

  /*
   * --handoff: the block you paste as the FIRST prompt of the next session.
   *
   * Everything here follows from one constraint — the reader is a fresh model with no
   * context, and every token it spends re-deriving a fact is one it does not spend on
   * the work. So relic derives them instead:
   *
   *   human turns only     what I said back is the session's output, not its intent,
   *                        and the next session is about to produce its own.
   *   time ONLY first+last a timestamp on every line is 20 repetitions of a fact that
   *                        matters twice. The span is what carries meaning.
   *   span, gaps, density  these ARE the intention signal. Twenty turns in eight
   *                        minutes at a 15s median gap is one person driving one thing
   *                        hard. Twenty turns over six hours with multi-hour gaps is
   *                        supervision of work running in parallel. The next session
   *                        should not infer that from a column of timestamps — it is
   *                        arithmetic, and arithmetic belongs in the tool.
   */
  const handoff = Boolean(f.handoff);
  const wantRole = f.role as string | undefined;
  const keepHarness = Boolean(f.harness);
  /*
   * A DROPPED TURN IS STILL A BOUNDARY.
   *
   * Harness turns are hidden, not deleted, because pairing needs to know they were
   * there. Filtering them out of the array entirely lets an assistant message that
   * answered a subagent report drift upward and pair with the human turn before it:
   * running --handoff on the session that built this showed "suggest me" answered by
   * a PR report it had nothing to do with. The reply had crossed a turn that was no
   * longer in the list.
   *
   * So: `hidden` marks what the reader must not see, and the pairing below treats any
   * user-channel turn — hidden or not — as the end of an exchange.
   */
  const marked = parsed.events
    .filter(e => (wantRole ? e.role === wantRole : e.role === "user" || e.role === "assistant"))
    .map(e => ({
      // ROLE NARROWS, IT DOES NOT DISABLE THE HARNESS FILTER. The first version
      // returned early on --role, so `--role user` — the flag people reach for to see
      // what the HUMAN asked — was the one view that showed raw <bash-stdout> dumps
      // and pasted skill bodies. Narrowing to the human is exactly when it matters.
      e,
      hidden: !keepHarness && e.role === "user" && isHarnessTurn(e.text),
      // Only an INBOUND hidden turn ends an exchange. See isInboundTurn().
      breaks: e.role === "user" && (!isHarnessTurn(e.text) || isInboundTurn(e.text)),
    }));
  const rows = marked.filter(m => !m.hidden).map(m => m.e);
  /*
   * EXCHANGES BY DEFAULT, not messages.
   *
   * A chronological tail of a busy session is almost entirely assistant — one
   * exchange emits many assistant messages, the narration between tool calls. Asking
   * for "the last 15 turns" and getting 15 of my own progress notes answers nothing
   * about what happened.
   *
   * An exchange is: the human's turn, plus the LAST thing I said before they spoke
   * again. The last one, not the first — the first is "let me check that", the last
   * is the conclusion. That pair is the unit a reader means by "a turn".
   *
   * --flat restores the raw message tail; --role already bypasses pairing, because
   * asking for one role means you want that role's messages.
   */
  let tail: typeof rows;
  if (!wantRole && !f.flat) {
    const pairs: typeof rows = [];
    for (let i = 0; i < marked.length; i++) {
      if (marked[i].hidden || marked[i].e.role !== "user") continue;
      let last: (typeof rows)[number] | null = null;
      // Stop at the next turn that BREAKS the exchange — a visible human turn, or a
      // hidden inbound one. A hidden turn the human's own turn caused does not break.
      for (let j = i + 1; j < marked.length && !marked[j].breaks; j++) {
        if (!marked[j].hidden) last = marked[j].e;
      }
      pairs.push(marked[i].e);
      if (last) pairs.push(last);
    }
    // n counts EXCHANGES, so take 2n messages — that is what the flag means to read.
    tail = pairs.slice(-Math.max(2, n * 2));
  } else {
    tail = rows.slice(-Math.max(1, n));
  }
  const omitted = rows.length - tail.length;

  const mode = outFmt(f);
  if (mode === "json")  { console.log(JSON.stringify({ file, title: parsed.title, turns: tail }, null, 2)); return; }
  if (mode === "jsonl") { for (const e of tail) console.log(JSON.stringify(e)); return; }
  if (mode === "plain") { for (const e of tail) console.log(`${e.seq}\t${e.role}\t${e.text.replace(/\s+/g, " ")}`); return; }

  if (handoff) { printHandoff(parsed.title, tail, rows.length, chars || 220); return; }

  if (parsed.title) console.log(`${parsed.title}`);
  // Say what was filtered OUT. "10 turns" and "10 turns of 1,751" are different facts,
  // and so is "harness turns hidden" — the reader has to know what they are not seeing.
  /*
   * NAME THE ROLE MIX, because "last 10 turns" is not what people expect.
   *
   * One exchange emits many assistant messages — narration between tool calls — so a
   * chronological tail of a busy session is almost entirely assistant. That is
   * correct and unhelpful; saying so points the reader at `--role user`, which is
   * what "what did I last ask" actually needs.
   */
  const mix = tail.reduce((m, e) => m.set(e.role, (m.get(e.role) ?? 0) + 1), new Map<string, number>());
  const mixed = [...mix].map(([r, c]) => `${c} ${r}`).join(" · ");
  console.log(`last ${tail.length} of ${fmt(rows.length)} turns  (${mixed})` +
              (keepHarness ? " (harness included)" : "") +
              `  ·  ${fmt(parsed.events.length)} events in file  ·  read from disk, not the index`);
  if (!wantRole && f.flat && !mix.get("user"))
    console.log(`  note: no human turns in this window — one exchange emits many assistant messages.` +
                `  drop --flat for exchanges, or --role user for what was asked.`);
  console.log("");
  for (const e of tail) {
    console.log(`#${String(e.seq).padStart(5)} ${e.role}${e.ts ? `  ${localDateTime(e.ts)}` : ""}`);
    const text = chars > 0 ? e.text.slice(0, chars) + (e.text.length > chars ? " …" : "") : e.text;
    console.log(text.replace(/^/gm, "  "));
    console.log();
  }
  if (omitted > 0) console.log(`${fmt(omitted)} earlier turns not shown (-n N)`);
}

// ---- report ----------------------------------------------------------------
/**
 * Day by day, with the shape a flat list cannot show.
 *
 * `sessions` is a feed — most recent N, newest first, one line each. A week is a
 * different question: quiet days versus spikes, which repo owned a day, whether work
 * sat in the main checkout or scattered across worktrees. `--limit 40` truncates that
 * before the second day starts.
 *
 * Transcript tiers only by default, and that is not cosmetic. `sessions` holds one row
 * per indexed FILE of any kind, and the vault outnumbers conversations 100:1 — an
 * unfiltered week reported 42,827 "sessions", of which 42,403 were ψ notes. The three
 * enormous daily spikes in that histogram were vault INDEXING runs, not activity.
 */
async function cmdReport(f: Record<string, string | boolean>) {
  const scope = { dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
                  repo: f.repo ? String(f.repo) : undefined,
                  bank: f.bank ? String(f.bank) : undefined };
  if (!pickShards(scope).length) { console.log("no shards match"); return; }

  const since = (f.since as string) ?? "7d";
  // group:false — one row per TRANSCRIPT. --tree needs every child's path, and the
  // grouped summary keeps only a count.
  const { rows, shards } = await listSessions({
    ...scope, since, until: f.until as string, worktree: f.worktree as string,
    group: false, limit: 1_000_000,
    // [] means "no tier predicate at all" in store.sessions(); undefined falls back to
    // TRANSCRIPT_TIERS. Both arms read `undefined` before, so --all-tiers was accepted
    // and silently did nothing here while it worked everywhere else.
    tiers: f["all-tiers"] ? [] : undefined,
  });
  void shards;

  const days = buildReport(rows as unknown as ReportRow[], nameOf);
  const mode = outFmt(f);
  if (mode === "json")  { console.log(JSON.stringify(days, null, 2)); return; }
  if (mode === "jsonl") { for (const d of days) console.log(JSON.stringify(d)); return; }
  if (mode === "plain") {
    for (const d of days) for (const s of d.sessions)
      console.log([d.day, localTime(s.startedAt), s.id, s.repo, s.worktree, s.events, s.transcripts, s.name].join("\t"));
    return;
  }

  const totS = days.reduce((a, d) => a + d.sessions.length, 0);
  const totE = days.reduce((a, d) => a + d.events, 0);
  const totT = days.reduce((a, d) => a + d.transcripts, 0);
  console.log(`${fmt(totS)} sessions · ${fmt(totT)} transcripts · ${fmt(totE)} events` +
              ` · ${days.length} day${days.length === 1 ? "" : "s"} · since ${since}` +
              (f.repo ? ` · repo~${f.repo}` : "") + ` · times local UTC${zoneOffset()}`);
  // Absence is a fact: a day with no sessions is missing from this list, not zero.
  for (const line of renderReport(days, { tree: Boolean(f.tree), perRepo: Number(f["per-repo"] ?? 4) }))
    console.log(line);
  if (!days.length) console.log("\n  nothing in range — widen --since, or check `relic status` for index freshness");
}

// ---- status ----------------------------------------------------------------
/**
 * `relic langs` — the language mix of the embeddable corpus, and which measured model
 * fits it. Read-only: it samples `events` and reads `vectors` stats, never writes.
 */
async function cmdLangs(f: Record<string, string | boolean>) {
  const sample = f.sample === undefined ? 64 : typeof f.sample === "string" ? Number(f.sample) : NaN;
  if (!Number.isInteger(sample) || sample < 1) {
    console.error("--sample takes a whole number N >= 1 (read 1 event in N; 1 reads every event)");
    process.exit(1);
  }
  // Every flag that narrowed the measurement rides into the printed embed command, so
  // "continue with" acts on the scope that was measured — never silently on the whole index.
  const scopeArgs: string[] = [];
  for (const k of ["data-root", "repo", "bank", "min-chars", "max-chars"] as const)
    if (typeof f[k] === "string") scopeArgs.push(`--${k}`, f[k] as string);
  for (const k of ["in-repo", "all-tiers"] as const) if (f[k]) scopeArgs.push(`--${k}`);
  const bar = progress();
  const r = await scanLangs({
    scopeArgs,
    dataRoot: (f["data-root"] as string) ?? null,
    inRepo: Boolean(f["in-repo"]),
    repo: f.repo ? String(f.repo) : undefined,
    bank: f.bank ? String(f.bank) : undefined,
    sample,
    // Same flags, same meaning as embed: the population measured is the one embedded.
    mainTiers: !f["all-tiers"],
    minChars: f["min-chars"] ? Number(f["min-chars"]) : 24,
    maxChars: f["max-chars"] ? Number(f["max-chars"]) : 2000,
    onProgress: (done, total, key) => {
      if (outFmt(f) === "pretty") bar.tick(`  ${done}/${total} shards  ${key}   `, (done / total) * 100, done === total);
    },
  });
  bar.clear();
  const rec = recommend(r);
  if (outFmt(f) === "json") { console.log(JSON.stringify({ ...r, recommendation: rec }, null, 2)); return; }
  if (outFmt(f) === "jsonl") { console.log(JSON.stringify({ ...r, recommendation: rec })); return; }
  if (!r.shards) { console.log("no shards match — check --repo / --bank, or run relic index first"); return; }
  console.log(renderLangs(r, rec));
}

/*
 * EMBED — a second pass over an index that is already complete.
 *
 * Deliberately not part of `index`. The measured result on this corpus is that the
 * full-text index WINS (MRR@20 0.890 vs 0.600 for the best of three models, bench/),
 * so embedding is opt-in, resumable, and scoped: `--repo`, `--bank` and `--limit` all
 * narrow it, and `--dry-run` answers "how much would this cost" without an HTTP call.
 */
async function cmdEmbed(f: Record<string, string | boolean>) {
  const o = {
    dataRoot: (f["data-root"] as string) ?? null,
    inRepo: Boolean(f["in-repo"]),
    repo: f.repo ? String(f.repo) : undefined,
    bank: f.bank ? String(f.bank) : undefined,
    provider: f.provider ? String(f.provider) : "ollama",
    model: f.model ? String(f.model) : "all-minilm",
    host: f.host ? String(f.host) : DEFAULT_OLLAMA,
    device: f.device ? String(f.device) : undefined,
    batch: f.batch ? Number(f.batch) : 64,
    limit: f.limit ? Number(f.limit) : undefined,
    // --all-tiers matches search's flag of the same name, so the population embedded
    // and the population searched are described by ONE vocabulary.
    mainTiers: !f["all-tiers"],
    minChars: f["min-chars"] ? Number(f["min-chars"]) : 24,
    maxChars: f["max-chars"] ? Number(f["max-chars"]) : 2000,
    dryRun: Boolean(f["dry-run"]),
    session: f.session ? String(f.session) : undefined,
    reset: Boolean(f.reset),
  };

  let last = 0;
  const bar = progress();
  const r = await embedShards({
    ...o,
    onProgress: p => {
      // Was `!== "text"`, a value outFmt never returns, so it never drew; the Python port says "pretty".
      if (outFmt(f) !== "pretty" || p.done - last < 200) return;
      last = p.done;
      bar.tick(`  ${p.shard}  ${fmt(p.done)}/${fmt(p.pending)}   `, (p.done / Math.max(1, p.pending)) * 100);
    },
  });
  bar.clear();

  if (outFmt(f) === "json") { console.log(JSON.stringify(r, null, 2)); return; }
  if (outFmt(f) === "jsonl") { for (const sh of r.shards) console.log(JSON.stringify(sh)); return; }

  const touched = r.shards.filter(sh => sh.eligible > 0 || sh.skipped);
  if (!touched.length) {
    // Two different nothings, and reporting them as one sent the first test of this
    // command chasing a --bank typo when the filter was doing exactly its job.
    if (!r.shards.length) console.log("no shards match — check --repo / --bank, or run relic index first");
    else console.log(`${r.shards.length} shards matched, but nothing is eligible: no event passes` +
                     ` ${o.mainTiers ? "the main-tiers filter" : "the filter"} at >= ${o.minChars} chars.` +
                     (o.mainTiers ? `\n(a memory or subagent bank is all non-main kinds — try --all-tiers)` : ""));
    return;
  }

  console.log(`provider  ${r.providerId}${r.dryRun ? "   (dry run — nothing written)" : ""}`);
  console.log(`scope     ${o.mainTiers ? "main tiers" : "all tiers"}, text >= ${o.minChars} chars, truncated at ${o.maxChars}\n`);
  const w = Math.max(6, ...touched.map(sh => sh.key.length));
  for (const sh of touched.slice(0, Number(f.limit ?? 40))) {
    if (sh.skipped) { console.log(`  ${sh.key.padEnd(w)}  SKIP  ${sh.skipped}`); continue; }
    const cov = sh.eligible ? Math.round((sh.already + sh.embedded) / sh.eligible * 100) : 0;
    console.log(`  ${sh.key.padEnd(w)}  ${String(cov).padStart(3)}%  ` +
                `${fmt(sh.already + sh.embedded)}/${fmt(sh.eligible)} embedded` +
                (sh.embedded ? `  +${fmt(sh.embedded)} this run` : "") +
                (sh.pending && r.dryRun ? `  ${fmt(sh.pending)} pending` : "") +
                (sh.failed ? `  ${fmt(sh.failed)} FAILED` : "") +
                (sh.dim ? `  dim ${sh.dim}` : ""));
  }
  const secs = r.ms / 1000;
  console.log(`\n${fmt(r.embedded)} embedded · ${fmt(r.pending)} pending · ${fmt(r.failed)} failed` +
              ` · ${touched.length} shards · ${secs.toFixed(1)}s` +
              (r.embedded && secs > 0 ? `  (${(r.embedded / secs).toFixed(0)}/s)` : ""));
  if (r.dryRun) console.log(`\nre-run without --dry-run to write. Vectors go to the per-shard`);
  if (r.dryRun) console.log(`\`vectors\` table; \`events\` and the full-text index are untouched.`);
}

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
                  lastIndexed: string; newestSession: string; fts: string }[] = [];
    for (const sh of shards) {
      try {
        const st = await LanceStore.open(sh.dir);
        const c = await st.counts();
        const fr = await st.freshness();
        rows.push({ key: sh.key, bank: sh.bank, repo: sh.repo,
                    // ev/se predate the rest of this row and something may read them.
                    // events/sessions are the names everything else uses.
                    ev: c.events, se: c.sessions, events: c.events, sessions: c.sessions,
                    lastIndexed: fr.lastIndexed, newestSession: fr.newestSession,
                    fts: (await st.ftsTokenizer()) ?? "none" });
      } catch { /* skip unreadable shard */ }
    }
    rows.sort((a, b) => b.ev - a.ev);
    if (smode === "jsonl") { for (const r of rows) console.log(JSON.stringify(r)); }
    else console.log(JSON.stringify({ root: dataRoot ?? defaultRoot(), shards: rows.length,
      events: rows.reduce((a, r) => a + r.ev, 0), sessions: rows.reduce((a, r) => a + r.se, 0), rows }, null, 2));
    return;
  }
  console.log(`layout  ${dataRoot ?? (Boolean(f["in-repo"]) ? `in-repo ${ghqRoot()}/<org>/<repo>/.relic/` : defaultRoot())}`);
  console.log(`store   LanceDB + ICU full-text index (BM25)`);
  /*
   * THE GHQ ROOT, AND WHETHER IT EXISTS.
   *
   * repoKeyOf() finds `github.com/<org>/<repo>` in a path without touching disk, so it
   * works regardless. resolveRepoKey()'s two fallbacks do NOT: they resolve a bare repo
   * name against an index of what is actually checked out, and an index of zero silently
   * disables them.
   *
   * Measured on white.local, 2026-09-19: `ghq.root` was unset, so ghq answered with its
   * built-in default ~/ghq — a directory that DOES NOT EXIST — while the 28 real repos
   * sat in ~/Code. relic rebuilt a whole bank, reported success, and attributed nothing,
   * because the feature had quietly become a no-op. One line here is the difference
   * between that and a five-minute diagnosis.
   */
  const gr = ghqRoot();
  const repos = repoIndex().size;
  console.log(`repos   ${gr}` + (existsSync(gr)
    ? `  ·  ${fmt(repos)} repo names indexed`
    : `  ⚠ DOES NOT EXIST — worktree/scratchpad paths cannot resolve to a repo.` +
      `\n        set it: git config --global ghq.root <path>`));
  console.log("");

  const rows: { bank: string; repo: string; events: number; sessions: number;
                lastIndexed: string; newestSession: string; fts: string }[] = [];
  for (const s of shards) {
    try {
      const st = await LanceStore.open(s.dir);
      const c = await st.counts();
      const fr = await st.freshness();
      rows.push({ bank: s.bank, repo: s.repo, events: c.events, sessions: c.sessions,
                  lastIndexed: fr.lastIndexed, newestSession: fr.newestSession,
                  fts: (await st.ftsTokenizer()) ?? "none" });
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
  // Only shards that hold events can have an index; an empty one is not a degraded one.
  const withEv = rows.filter(r => r.events > 0);
  const simple = withEv.filter(r => r.fts === "simple"), noFts = withEv.filter(r => r.fts === "none");
  console.log(`fts     ${fmt(withEv.length - simple.length - noFts.length)} ICU` +
              (simple.length ? `  ·  ${simple.length} simple` : "") +
              (noFts.length ? `  ·  ${noFts.length} no index (slow LIKE scan)` : ""));
  if (simple.length) {
    console.log(`  \u26A0 Thai substring search degraded on ${simple.length === 1 ? "this shard" : "these shards"}` +
                ` — built with \`simple\` where LanceDB had no ICU; a run where ICU loads rebuilds them:`);
    for (const r of simple.slice(0, limit)) console.log(`    ${r.bank}  ${r.repo.replace("github.com/", "")}`);
    if (simple.length > limit) console.log(`    ... and ${simple.length - limit} more (--limit N)`);
  }
  /*
   * VECTORS, MEASURED — this line used to be a hardcoded claim that vectors "land in
   * the same `events` table, no migration". Both halves were wrong: they land in a
   * separate `vectors` table, because a vector column cannot be added to `events` by
   * widening without silently becoming text. A status line that states a design
   * intention instead of reading the disk is how a wrong plan survives being disproved.
   */
  let vRows = 0, vShards = 0;
  const models = new Set<string>();
  for (const sh of shards) {
    try {
      const st = await (await LanceStore.open(sh.dir)).vectorStats();
      if (!st || !st.rows) continue;
      vShards++; vRows += st.rows;
      if (st.model) models.add(`${st.model}/${st.dim}d`);
    } catch { /* an unreadable shard is not a vector report */ }
  }
  console.log(vRows
    ? `vectors ${fmt(vRows)} in ${vShards} of ${shards.length} shards` +
      `  ·  ${[...models].join(", ")}  ·  written by \`relic embed\`, not read by \`search\` yet`
    : "vectors none — `relic index` never writes them; see `relic embed --dry-run`");
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
    if (!live.length) {
      console.log(`nothing written in the last ${humanAge(windowSec)}`);
      for (const note of hermesOffNotes()) console.log(`  ${note}`);
      return;
    }
    console.log(`${live.length} session${live.length === 1 ? "" : "s"} active in the last ${humanAge(windowSec)}\n`);
    for (const s of live) {
      const wrote = Math.abs(s.ageSec - s.eventAgeSec) > 180 ? `  (write ${humanAge(s.ageSec)} ago)` : "";
      console.log(`${humanAge(s.eventAgeSec).padStart(5)} ago  ${shortId(s.sessionUuid)}  ` +
        `${String(s.agents).padStart(3)} live agent${s.agents === 1 ? " " : "s"}  ${s.title ?? "(untitled)"}${wrote}`);
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
  console.log(`${cur.sessionUuid}  ·  ${clockLabel(cur.ageSec, cur.eventAgeSec)}`);
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

async function cmdLineage(arg: string | undefined, f: Record<string, string | boolean>) {
  const cur = await currentSession();
  const all = Boolean(f.all);
  let l: Lineage;
  if (arg) {
    const hits = findSessions(arg);
    if (hits.length > 1) {
      console.error(`${arg} matches ${hits.length} sessions — give more of the id:`);
      for (const h of hits.slice(0, 10)) console.error(`  ${h.id}  ${h.projectDir}`);
      process.exit(1);
    }
    if (hits.length === 1) l = await buildLineage(hits[0].projectDir, hits[0].id, { all });
    else {
      // Not a Claude transcript: a Hermes id links from state.db rows instead (#74).
      const hermes = findHermesSessions(arg);
      if (hermes.length > 1) {
        console.error(`${arg} matches ${hermes.length} Hermes sessions — give more of the id:`);
        for (const h of hermes.slice(0, 10)) console.error(`  ${h.id}  ${h.db}`);
        process.exit(1);
      }
      if (!hermes.length) {
        console.error(`no Claude Code transcript or Hermes session matches ${arg}`);
        for (const note of hermesOffNotes()) console.error(`  ${note}`);
        process.exit(1);
      }
      l = buildHermesLineage(hermes[0].db, hermes[0].id, { all });
    }
  } else {
    if (!cur) { console.error(`no session transcript for ${process.cwd()} — pass an id`); process.exit(1); }
    if (!isClaudeProjectDir(cur.projectDir)) {
      console.error(`lineage reads Claude Code transcripts; this session is under ${cur.projectDir}`);
      process.exit(1);
    }
    l = await buildLineage(cur.projectDir, cur.sessionUuid, { all });
  }

  const mode = outFmt(f);
  if (mode === "json") { console.log(JSON.stringify(lineageJSON(l), null, 2)); return; }
  if (mode === "plain" || mode === "jsonl") {
    const parent = new Map(l.links.map(k => [k.child, k]));
    for (const n of [...l.nodes].sort((a, b) => a.startMs - b.startMs)) {
      const k = parent.get(n.id);
      const row = { id: n.id, parent: k?.parent ?? null, kind: k?.kind ?? null, gapMs: k?.gapMs ?? null,
                    start: new Date(n.startMs).toISOString(), end: new Date(n.endMs).toISOString(), title: n.title ?? n.prompt };
      console.log(mode === "jsonl" ? JSON.stringify(row)
        : [row.id, row.parent ?? "-", row.kind ?? "-", row.gapMs ?? "-", row.start, row.end, row.title ?? ""].join("\t"));
    }
    return;
  }
  console.log(renderLineage(l, { current: cur?.sessionUuid ?? null }));
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

// ---- skipped --files ---------------------------------------------------------
/**
 * Paths the walk could not read (#99): the file-scoped half of the proof log.
 *
 * Same log and same rule buckets as the event view, but one row per PATH — an
 * unreadable directory is logged again by every index run until someone fixes it, and
 * listing it forty times would bury the second one.
 */
function cmdSkippedFiles(f: Record<string, string | boolean>) {
  const dataRoot = (f["data-root"] as string) ?? null;
  const r = readSkippedFiles(dataRoot);
  if (outFmt(f) === "json") { console.log(JSON.stringify(r ?? { total: 0, byRule: [], paths: [] }, null, 2)); return; }
  if (!r) { console.log(`no unreadable paths logged — ${skippedPath(dataRoot)}`); return; }
  console.log(`${fmt(r.total)} path${r.total === 1 ? "" : "s"} the walk could not read — ` +
              `nothing in ${r.total === 1 ? "it" : "them"} was indexed\n`);
  for (const b of r.byRule) console.log(`  ${b.rule.padEnd(26)} ${String(fmt(b.n)).padStart(7)}`);
  const limit = Number(f.limit ?? 20);
  for (const b of r.byRule) {
    const rows = r.paths.filter(x => x.rule === b.rule);
    console.log(`\n  [${b.rule}]`);
    for (const x of rows.slice(0, limit)) {
      console.log(`    ${x.path}`);
      console.log(`        ${x.error}  ·  last ${localDateTime(x.ts)}${x.runs > 1 ? `  ·  logged by ${fmt(x.runs)} runs` : ""}`);
    }
    if (rows.length > limit) console.log(`    ... and ${fmt(rows.length - limit)} more (--limit N, or --json)`);
  }
}

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

/** `/Users/x/...` -> `~/...`. A cwd is long and its prefix is the least useful part. */
function tildeHome(p: string): string {
  const h = homedir();
  return p && p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

async function cmdPending(f: Record<string, string | boolean>) {
  const r = await pendingReport({
    dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
    repo: f.repo ? String(f.repo) : undefined, bank: f.bank ? String(f.bank) : undefined,
    corpus: f.corpus && String(f.corpus) !== "all" ? String(f.corpus).split(",") : null,
    since: f.since ? String(f.since) : undefined,
    // `--list` with no value means "a screenful", not "zero" — a bare flag parses as
    // boolean true, and Number(true) is 1, which would silently show one row.
    //
    // ABSENT is not the same as 0 and must stay undefined: it means "decide for me",
    // which pendingReport answers by listing a small pending set and capping a large
    // one. Mapping it to 0 here is what made the default report say "missing 1" and
    // then refuse to say which.
    list: f.list === undefined ? undefined : (f.list === true ? 20 : Number(f.list)),
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
  if (r.unreadable.length)
    console.log(`\u26A0 ${fmt(r.unreadable.length)} path${r.unreadable.length === 1 ? "" : "s"} could not be read (named on stderr) — ` +
                `files under ${r.unreadable.length === 1 ? "it are" : "them are"} in none of these counts`);
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
    console.log(`\nnot indexed yet — newest first (name, cwd and repo read from each transcript):\n`);
    console.log(`  ${"when".padEnd(17)} ${"session".padEnd(10)} ${"state".padEnd(8)} ` +
                `${"source/tier".padEnd(26)} repo`);
    for (const x of r.files) {
      console.log(`  ${localDateTime(new Date(x.mtime * 1000).toISOString()).padEnd(17)} ` +
                  `${(x.sessionId ? x.sessionId.slice(0, 8) : "-").padEnd(10)} ` +
                  `${x.state.padEnd(8)} ` +
                  `${(x.source + "/" + x.tier).padEnd(26)} ${x.repo}`);
      // The identity line. `bank` moved off the row above to make room: it is derivable
      // from source, while a session's name and cwd are not derivable from anything.
      // nameOf returns "(untitled)" when a transcript wrote no title and no usable
      // description. Printing that in quotes is worse than printing nothing — it looks
      // like the session is literally called that.
      const named = x.name && x.name !== "(untitled)" ? `"${x.name.slice(0, 60)}"` : "";
      const bits = [named, tildeHome(x.cwd)].filter(Boolean);
      if (bits.length) console.log(`  ${" ".repeat(17)} ${bits.join("   ")}`);
    }
    if (r.filesOmitted) console.log(`\n  ... and ${fmt(r.filesOmitted)} more pending (--list N)`);
  } else if (r.missing + r.changed === 0) {
    console.log(r.unreadable.length ? `\nnothing pending among the files the walk could read.`
                                    : `\nnothing pending — every discovered file is in the index.`);
  }
}

if (!cmd || f.help) {
  console.log(helpText());
  process.exit(0);
}

if (cmd === "index") await cmdIndex(f);
else if (cmd === "prune") await cmdPrune(f);
else if (cmd === "report") await cmdReport(f);
else if (cmd === "tail") await cmdTail(pos[1] ?? "", f);
else if (cmd === "search") { if (!pos[1]) { console.error("search needs a query"); process.exit(1); } await cmdSearch(pos.slice(1).join(" "), f); }
else if (cmd === "show") { if (!pos[1]) { console.error("show needs a file"); process.exit(1); } await cmdShow(pos[1], f); }
else if (cmd === "sources") {
  console.log("configured sources (~/.relic/sources.json overrides)\n");
  const det = detect();
  for (const s of det)
    console.log(`  ${s.enabled ? "[on] " : "[off]"} ${s.key.padEnd(16)} ${s.present ? "present" : "MISSING"}  bank=${s.bank.padEnd(22)} ${s.path}\n         ${s.note}`);
  const banks = [...new Set(det.filter(s => s.enabled).map(s => s.bank))];
  console.log(`\n  ${banks.length} banks would be written: ${banks.join(" · ")}`);

  /*
   * WHAT THE ENVIRONMENT SAYS, versus what is configured.
   *
   * Claude Code reads its home from CLAUDE_CONFIG_DIR and Codex from CODEX_HOME — one
   * path each, not a list. If either points somewhere relic has no source for, every
   * command still succeeds over the DEFAULT home and prints a clean summary for the
   * wrong agent's history. Reported, never acted on: silently following an env var
   * would write another account's transcripts into a bank named for this one.
   */
  const envs = envHomes();
  if (envs.length) {
    console.log("\nagent homes this environment points at:");
    for (const e of envs) {
      const covered = det.some(s => s.enabled && s.path.startsWith(e.path));
      const mark = e.isDefault ? "[default]" : covered ? "[covered] " : "[MISSING] ";
      console.log(`  ${mark} ${e.env}=${e.path}`);
      if (!e.isDefault && !covered)
        console.log(`           no enabled source reads this home — declare it:\n` +
                    `           ~/.relic/sources.json  { "homes": [{ "key": "<name>", "path": "${e.path}" }] }`);
    }
  }
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
else if (cmd === "lineage") await cmdLineage(pos[1], f);
else if (cmd === "chain") {
  if (!pos[1]) { console.error("chain needs a session id or prefix"); process.exit(1); }
  const { chain, imported, unindexed } = await chainOf(pos[1], {
    dataRoot: (f["data-root"] as string) ?? null, inRepo: Boolean(f["in-repo"]),
    noIndex: Boolean(f["no-index"]), skipNoise: wantSkipNoise(f),
  });
  if (imported) process.stderr.write(`not indexed — found ${imported} file(s) on disk, imported\n`);
  if (!chain) console.log(`no session matches ${pos[1]}`);
  else if (outFmt(f) === "json") console.log(JSON.stringify({ ...chain, unindexed }, null, 2));
  else {
    console.log(renderChain(chain, { width: Number(f.width ?? 40), maxRows: Number(f.limit ?? 8) }));
    if (unindexed) console.log(`\n${unindexedHint(unindexed)}`);
  }
}
else if (cmd === "session") { if (!pos[1]) { console.error("session needs an id or prefix"); process.exit(1); } await cmdSession(pos[1], f); }
else if (cmd === "sessions") await cmdSessions(f);
else if (cmd === "skipped" && f.files) cmdSkippedFiles(f);
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
  // Same log, other kind of row: point at it rather than fold paths into event counts.
  const lost = outFmt(f) === "json" ? null : readSkippedFiles(dataRoot);
  if (lost) console.log(`\n${fmt(lost.total)} path${lost.total === 1 ? "" : "s"} the walk could not read -> relic skipped --files`);
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
else if (cmd === "recap") await cmdRecap(await recapTarget(pos[1]), f);
else if (cmd === "serve") {
  const { serve } = await import("./serve.js");
  await serve({
    host: String(f.host ?? "127.0.0.1"),
    port: Number(f.port ?? 4319),
    // Flag first, then env. The env var is what a launchd/systemd unit can set without
    // the token appearing in `ps` output, which the flag does.
    token: (f.token ? String(f.token) : process.env.RELIC_TOKEN) || null,
    origins: f.origin ? String(f.origin).split(",").map(x => x.trim()).filter(Boolean) : [],
  });
}
else if (cmd === "probe") await cmdProbe(f);
else if (cmd === "embed") await cmdEmbed(f);
else if (cmd === "langs") await cmdLangs(f);
else if (cmd === "status") await cmdStatus(f);
else { console.error(`unknown command: ${cmd}`); process.exit(1); }
