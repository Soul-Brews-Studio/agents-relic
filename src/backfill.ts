import { statSync } from "node:fs";
import { LanceStore, type SessionRow } from "./store/lance.js";
import type { Found, Tier } from "./discover.js";
import { loadSources, parserFor } from "./sources.js";
import { resolveRepoKey } from "./repo.js";
import { parseChannelEnvelope } from "./types.js";
import { parseClaude } from "./shapes/claude.js";
import { pickShards, nameOf, type Scope } from "./query.js";
import { importFiles, type ImportOpts, type ImportTally } from "./import.js";

/**
 * `relic index --backfill-channel` — re-read the transcripts whose rows predate what
 * import now writes.
 *
 * widen() gives an old shard the facet columns with "" in every existing row, and a row
 * keeps that "" until its file changes, which for a finished session is never. The index
 * has no force flag, so this is the explicit, opt-in way to re-import a NAMED set of
 * files, through the same path a changed file takes: delete its rows by file_path, then
 * write the new ones.
 *
 * Two reasons a file is on the list:
 *   facets  a user turn opens with a channel envelope and carries no `via`
 *   names   its session description still opens with an envelope tag. #92 strips at
 *           import now; rows from before keep the tag, and where it ran past the
 *           200-char cut, the words the human typed are not in the row at all.
 *
 * The list comes from the INDEX, not a discovery walk: a candidate's own session row
 * already says its tier, source, project dir and agent, so nothing off the list is
 * statted, and nothing is re-derived from a path.
 */

export interface BackfillFile {
  found: Found;
  shard: string;         // the shard directory holding its rows now
  why: ("facets" | "names")[];
  turns: number;         // channel turns in this file with no facets yet
  untitled: boolean;     // named "(untitled)" until it is re-read
}

export interface BackfillPlan {
  files: BackfillFile[];
  scanned: number;       // shards read
  bytes: number;         // on disk, across `files` — what re-reading costs
  skipped: {
    gone: number;        // the file, or its session row, is no longer there
    moved: number;       // its cwd resolves to another repo now: a re-import would land in another shard
    otherShape: number;  // not a Claude transcript — only that shape parses envelopes
  };
  ms: number;
}

export async function planChannelBackfill(s: Scope): Promise<BackfillPlan> {
  const t0 = Date.now();
  const sources = loadSources();
  const plan: BackfillPlan = { files: [], scanned: 0, bytes: 0, skipped: { gone: 0, moved: 0, otherShape: 0 }, ms: 0 };

  for (const sh of pickShards(s)) {
    let store: LanceStore, found: Awaited<ReturnType<LanceStore["channelBackfill"]>>;
    try {
      store = await LanceStore.open(sh.dir);
      found = await store.channelBackfill();
    } catch { continue; }            // a shard mid-write can throw; the rest still answer
    plan.scanned++;

    // Confirmed with the parser, not the LIKE: a `<channel` it rejects would be re-read
    // on every run and never leave the list.
    const turns = new Map<string, number>();
    for (const r of found.facets)
      if (parseChannelEnvelope(String(r.text))) turns.set(String(r.file_path), (turns.get(String(r.file_path)) ?? 0) + 1);
    const named = new Map(found.names.map(r => [String(r.file_path), r]));
    if (!turns.size && !named.size) continue;

    const rows = new Map<string, SessionRow>(named);
    for (const r of await store.sessionsOf([...turns.keys()].filter(p => !named.has(p))))
      rows.set(String(r.file_path), r);

    for (const path of new Set([...turns.keys(), ...named.keys()])) {
      const r = rows.get(path);
      const parser = r && (sources.find(x => x.key === r.source)?.parser ?? parserFor(path));
      let st: { mtimeMs: number; size: number } | null = null;
      try { st = statSync(path); } catch { /* gone */ }
      if (!r || !st) { plan.skipped.gone++; continue; }
      if (parser !== parseClaude) { plan.skipped.otherShape++; continue; }
      // The importer files a row under the repo its cwd resolves to TODAY. If that is no
      // longer this shard, the new rows would land elsewhere and these would stay behind.
      if ((resolveRepoKey(r.cwd || null) ?? "_unresolved") !== sh.repo) { plan.skipped.moved++; continue; }

      plan.bytes += st.size;
      plan.files.push({
        shard: sh.dir,
        found: {
          path, projectDir: String(r.project_dir ?? ""), tier: r.tier as Tier, source: r.source, bank: sh.bank,
          workflowRunId: r.workflow_run_id || null, agentId: r.agent_id || null,
          mtime: Math.floor(st.mtimeMs / 1000), size: st.size, parser: parseClaude,
        },
        why: [...(turns.has(path) ? ["facets" as const] : []), ...(named.has(path) ? ["names" as const] : [])],
        turns: turns.get(path) ?? 0,
        untitled: named.has(path) && nameOf(named.get(path)!) === "(untitled)",
      });
    }
  }
  plan.ms = Date.now() - t0;
  return plan;
}

/** Re-import what the plan names. The same importer as `index`, told not to skip them. */
export async function applyChannelBackfill(plan: BackfillPlan, o: ImportOpts): Promise<ImportTally> {
  const found = plan.files.map(f => f.found);
  return importFiles(found, { ...o, reimport: new Set(found.map(f => f.path)) });
}
