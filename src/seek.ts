import { readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { bankOf, loadSources, transcriptRoots } from "./sources.js";
import type { Found, Tier } from "./discover.js";

/**
 * Find a transcript on DISK by session id, without consulting the index.
 *
 * This exists so `relic session <id>` never answers "run index first". A session id
 * maps to a filename, so locating it is a deterministic lookup — not something that
 * should require a human (or a model) to improvise a `find` invocation. The index is
 * an accelerator; the filesystem is the source of truth, and it is always available.
 *
 * Bounded on purpose: this matches a FILENAME PREFIX in the places transcripts are
 * known to live. It never walks the whole tree and never greps content — a full sweep
 * is what makes this class of lookup feel expensive enough to skip.
 */

const SUB = "subagents";
const WF = "workflows";

function dirs(p: string): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); }
  catch { return []; }
}
function files(p: string): string[] {
  try { return readdirSync(p, { withFileTypes: true }).filter(e => e.isFile() && e.name.endsWith(".jsonl")).map(e => e.name); }
  catch { return []; }
}
function statOf(p: string) {
  try { const s = statSync(p); return { mtime: Math.floor(s.mtimeMs / 1000), size: s.size }; }
  catch { return null; }
}

/** Every transcript whose filename starts with `id`, across all configured sources. */
export function seekOnDisk(id: string): Found[] {
  const out: Found[] = [];
  const want = (name: string) => name.startsWith(id);

  for (const src of loadSources()) {
    if (!existsSync(src.path)) continue;
    // TRANSCRIPT layouts only. `claude-memory` points at the SAME directory as
    // `claude-live`, so without this gate every session id matches a second time, is
    // parsed by parseMemory, and lands as a bogus one-event row in the memory bank.
    if (src.walk !== "claude-tiers" && src.walk !== "claude-home" && src.walk !== "flat" && src.walk !== "omp") continue;
    // Same bank the bulk walker would have stamped. Without it an on-demand
    // `relic session <id>` import writes into the fallback bank instead of the
    // source's own — a misfile that no error would report.
    const bank = bankOf(src);

    if (src.walk === "flat") {
      // Codex nests by date; bounded depth rather than an open-ended walk.
      const walk = (root: string, depth: number) => {
        for (const f of files(root)) {
          // rollout-<ts>-<uuid>.jsonl — the id is in the name, not at its start
          if (!want(f) && !f.includes(id)) continue;
          const st = statOf(join(root, f));
          if (st) out.push({ path: join(root, f), projectDir: src.key, tier: "session" as Tier,
            source: src.key, bank, workflowRunId: null, agentId: null, ...st, parser: src.parser });
        }
        if (depth >= 4) return;
        for (const d of dirs(root)) walk(join(root, d), depth + 1);
      };
      walk(src.path, 0);
      continue;
    }

    // Claude layout: check all three tiers, since a session id names a TREE.
    const projects = transcriptRoots(src).flatMap(root => dirs(root).map(name => ({ root, name })));
    for (const { root, name: project } of projects) {
      const pp = join(root, project);

      for (const f of files(pp)) {
        if (!want(f)) continue;
        const st = statOf(join(pp, f));
        if (st) out.push({ path: join(pp, f), projectDir: project, tier: "session",
          source: src.key, bank, workflowRunId: null, agentId: null, ...st, parser: src.parser });
      }

      // children live under <uuid>/subagents/... — so the DIRECTORY carries the id
      for (const sessionDir of dirs(pp)) {
        if (!want(sessionDir)) continue;
        const sub = join(pp, sessionDir, SUB);
        if (!existsSync(sub)) continue;

        for (const f of files(sub)) {
          const st = statOf(join(sub, f));
          if (st) out.push({ path: join(sub, f), projectDir: project, tier: "subagent",
            source: src.key, bank, workflowRunId: null, agentId: basename(f, ".jsonl"), ...st, parser: src.parser });
        }
        const wf = join(sub, WF);
        for (const run of dirs(wf)) {
          if (!run.startsWith("wf_")) continue;
          for (const f of files(join(wf, run))) {
            // journal.jsonl is the workflow RUNNER's event log, not a transcript.
            // discover.ts skips it; this path did not, so an on-demand
            // `relic session <id>` imported one bogus workflow_agent row per run.
            // Found by porting seek to Python: 162 files there against 169 here,
            // and this session has exactly 7 wf_ runs.
            if (f === "journal.jsonl") continue;
            const st = statOf(join(wf, run, f));
            if (st) out.push({ path: join(wf, run, f), projectDir: project, tier: "workflow_agent",
              source: src.key, bank, workflowRunId: run, agentId: basename(f, ".jsonl"), ...st, parser: src.parser });
          }
        }
      }
    }
  }
  return out;
}
