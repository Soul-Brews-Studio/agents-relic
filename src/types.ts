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
