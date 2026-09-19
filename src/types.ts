import { createHash } from "node:crypto";

/** One indexable line of a transcript. */
export interface ParsedEvent {
  uid: string;      // stable, path-independent: the same file under two roots dedups
  seq: number;      // Nth non-empty line — the jump-to key back into the file
  role: string;     // user | assistant | system | reasoning | tool_use | tool_result
  ts: string | null;
  text: string;
}

export interface ParsedFile {
  sessionUuid: string;
  cwd: string | null;          // the session's own cwd field — NOT decoded from the dir name
  model: string | null;
  events: ParsedEvent[];
  lines: number;
  badLines: number;
  typeCounts: Record<string, number>;
  startedAt: string | null;
  endedAt: string | null;
  description: string | null;  // first user message, truncated
  /**
   * The session's NAME, when the host wrote one.
   *
   * Claude Code emits `{"type":"ai-title","aiTitle":...}` — the label its own resume
   * picker shows. It repeats on nearly every turn (201 records in one session, all
   * identical), so take the LAST: a title written after the work is a better name for
   * it than one guessed from the opening message.
   *
   * null for Codex, which has no equivalent record. Callers fall back to description.
   */
  title: string | null;
  /**
   * The git branch the work happened on.
   *
   * Claude Code stamps `gitBranch` on EVERY record. The fleet's dig.py reads it only
   * from a `type:"summary"` record, which measured 0/120 on current transcripts while
   * gitBranch itself measured 120/120 — so that path reports "unknown" for every modern
   * session. Read it off any record instead.
   */
  gitBranch: string | null;
}

export type Parser = (filePath: string) => Promise<ParsedFile>;

/** Max chars stored per event. Longer text is truncated with a marker. */
export const MAX_TEXT = 16_000;

const SEP = String.fromCharCode(31); // unit separator — cannot occur in a path or seq

/**
 * Event identity. Deliberately excludes the directory: only the basename and the
 * line number participate, so the same transcript discovered under two roots
 * (live + archive, or two machines) collapses to one row instead of doubling.
 */
export function uidOf(source: string, fileKey: string, seq: number): string {
  return createHash("sha1").update([source, fileKey, seq].join(SEP)).digest("hex");
}

export function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export function truncate(s: string, max = MAX_TEXT): string {
  return s.length <= max ? s : s.slice(0, max) + `...[+${s.length - max}]`;
}

/**
 * What a content array actually IS, regardless of the message envelope carrying it.
 * Returns null for ordinary prose so the caller falls back to the envelope role.
 */
export function blockRole(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const kinds = new Set<string>();
  for (const raw of content) {
    const item = asObj(raw);
    const t = item ? str(item.type) : null;
    if (t) kinds.add(t);
  }
  if (kinds.size === 0) return null;
  // A block array that is ONLY tool traffic is tool traffic, whoever sent it.
  if (kinds.has("tool_result") && !kinds.has("text")) return "tool_result";
  if (kinds.has("tool_use") && !kinds.has("text")) return "tool_use";
  if (kinds.has("thinking") && kinds.size === 1) return "thinking";
  return null;
}

/** Flatten Claude/Codex content arrays into plain searchable text. */
export function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const out: string[] = [];
  for (const raw of content) {
    const item = asObj(raw);
    if (!item) continue;
    const t = str(item.text);
    if (t) { out.push(t); continue; }
    const type = str(item.type);
    if (type === "tool_use") {
      out.push(`[tool_use ${str(item.name) ?? "?"}] ${truncate(JSON.stringify(item.input ?? {}), 2000)}`);
    } else if (type === "tool_result") {
      const c = item.content;
      out.push(`[tool_result] ${truncate(typeof c === "string" ? c : JSON.stringify(c ?? ""), 4000)}`);
    } else if (type === "thinking") {
      const th = str(item.thinking);
      if (th) out.push(th);
    }
  }
  return out.join("\n");
}

/**
 * Text a HOST injected as the first "user" message, which is never a session's name.
 *
 * Both hosts do this and only Claude's shapes were recognised, so 64% of Codex sessions
 * were listed by their own boot directive. Measured over 1,750 codex sessions:
 *
 *   391  <recommended_plugins> Here is a list of plugins that are a...
 *   365  # AGENTS.md instructions <INSTRUCTIONS> <!-- AUTONOMY DIRE...
 *   358  <codex_internal_context source="goal"> Continue working to...
 *    12  # AGENTS.md instructions for /opt/Code/github.com/...
 *
 * The AGENTS.md blob alone is 27,708 characters, stored truncated to 200 — so every one
 * of those sessions was named by the same cut-off sentence, differing only in a path.
 *
 * ANCHORED AT THE START, deliberately. A human quoting `<recommended_plugins>` while
 * debugging is a real message and must keep its name; only a message that BEGINS as the
 * directive is the directive.
 */
const HOST_PREAMBLE = [
  /^#\s*AGENTS\.md instructions\b/i,
  /^<recommended_plugins>/i,
  /^<codex_internal_context\b/i,
  /^You have oh-my-codex installed\b/i,
  /^<INSTRUCTIONS>/i,
  /^<environment_context>/i,
];

export function isHostPreamble(text: unknown): boolean {
  const t = String(text ?? "").trimStart();
  return HOST_PREAMBLE.some(rx => rx.test(t));
}
