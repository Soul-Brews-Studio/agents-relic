import { statSync } from "node:fs";
import { dirname } from "node:path";
import { clearLine } from "./progress.js";

/**
 * A directory the walk could not read, said out loud (#99).
 *
 * Every walker used to answer a failed readdir or stat with an empty list, so an
 * unreadable directory looked exactly like an empty one. `relic pending` reported
 * "0 missing" because the walk never saw the files it would have called missing, and
 * a declared home whose root was unreadable contributed nothing without a word.
 *
 * ENOENT STAYS QUIET. These walkers probe optional paths all the time — most session
 * directories have no `subagents/`, most repos have no `wt/` — and a file can vanish
 * between readdir and stat on a live tree. Anything else (EACCES, EIO, ENOTDIR, ELOOP)
 * is a real failure and gets one stderr line per path per process. A path BENEATH one
 * already reported gets none: it is the same failure again, and an unreadable project
 * directory would otherwise report itself once for every probe made inside it.
 *
 * ENAMETOOLONG is absence too: the kernel saying no such name can exist here. `tail`
 * and `lineage` probe a directory named after the encoded cwd, and a deep cwd encodes
 * past the limit. The limit is not one number: measured on APFS it is 255 CHARACTERS
 * (a 200-character Thai name is 600 bytes and fine), while ext4's is 255 BYTES, where
 * a Thai path gets there three times sooner. No length check can know which filesystem
 * it is on; the error does.
 *
 * Two kinds, both of which drop data:
 *
 *   dir-unreadable   a directory could not be listed or reached — nothing under it is seen
 *   walk-error       one file could not be stat'ed — that file is skipped
 */

export type WalkRule = "dir-unreadable" | "walk-error";
export const WALK_RULES: readonly string[] = ["dir-unreadable", "walk-error"];

export interface WalkFailure { rule: WalkRule; path: string; error: string; ts: string }

/** The errors that mean "not there", as opposed to "there and unreadable". See above. */
const ABSENT = new Set(["ENOENT", "ENAMETOOLONG"]);

/*
 * Printing and collecting are scoped differently, on purpose. stderr hears about a
 * path once per PROCESS, so a long-lived MCP server does not repeat itself on every
 * call. The collection is per WALK: discover() starts a fresh one, so a report built
 * after it (pending, index) counts this walk's failures even when an earlier call in
 * the same process already printed them.
 */
const printed = new Set<string>();
let collected = new Map<string, WalkFailure>();

// Past this many lines stderr is a flood, not a warning. The collection keeps every one.
const MAX_LINES = 20;

/** Is `path`, or any directory above it, in `seen`? */
function covered(seen: { has(p: string): boolean }, path: string): boolean {
  for (let p = path; ; p = dirname(p)) {
    if (seen.has(p)) return true;
    if (dirname(p) === p) return false;
  }
}

/** "EACCES: permission denied" — the message without its ", scandir '<path>'" tail, which repeats the path. */
function describe(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/, [a-z_]+ '.*'$/s, "");
}

function report(rule: WalkRule, path: string, err: unknown): void {
  if (ABSENT.has(String((err as { code?: string } | null)?.code))) return;
  if (covered(collected, path)) return;
  const error = describe(err);
  collected.set(path, { rule, path, error, ts: new Date().toISOString() });

  if (covered(printed, path)) return;
  printed.add(path);
  if (printed.size > MAX_LINES + 1) return;
  clearLine();       // discovery repaints a progress line with \r; do not print into the middle of it
  process.stderr.write(printed.size > MAX_LINES
    ? `relic: more paths could not be read — not listing each one (an index run records them all: relic skipped --files)\n`
    : `relic: cannot read ${path}: ${error}\n`);
}

/** A readdir that failed: everything under `path` is invisible to this walk. */
export function dirUnreadable(path: string, err: unknown): void { report("dir-unreadable", path, err); }

/** A stat that failed: this one file is skipped. */
export function walkError(path: string, err: unknown): void { report("walk-error", path, err); }

/**
 * existsSync, minus the silence. existsSync answers false for EACCES exactly as it does
 * for ENOENT, so a session directory with no search permission hid its whole
 * `subagents/` tree behind what read as "this session has no subagents".
 */
export function reachable(path: string): boolean {
  try { statSync(path); return true; }
  catch (e) { dirUnreadable(path, e); return false; }
}

/** Start a fresh collection. discover() calls this, so what follows describes one walk. */
export function beginWalk(): void { collected = new Map(); }

/** Every failure since beginWalk(), each path once — for reports and the proof log. */
export function walkFailures(): WalkFailure[] { return [...collected.values()]; }
