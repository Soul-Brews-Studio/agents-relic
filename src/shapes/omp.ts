import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { asObj, str, truncate, uidOf, type ParsedEvent, type ParsedFile, type Parser } from "../types.js";

/**
 * omp (GLM/Claude-family coding agent) transcripts —
 * ~/.omp/agent/sessions/<encoded-cwd>/<timestamp>_<id>.jsonl
 *
 * Discovered 2026-09-18 while teaching a live omp pane to use relic. The prior source
 * survey in sources.ts called this "SQLITE, not JSONL" and excluded it — wrong: the
 * per-session transcripts sitting right next to history.db ARE plain JSONL, one event
 * per line. That survey error is why omp calling `relic_now` always resolved to
 * whichever OTHER agent's Claude Code session was newest in the same directory — omp
 * had no source of its own to be found in.
 *
 * Shape differs from Claude Code in the details but carries the same information:
 *   role 'user'       -> user prose, content is always an array of blocks (never bare string)
 *   role 'assistant'  -> content blocks: 'text' | 'thinking' | 'toolCall'
 *   role 'toolResult' -> its own envelope role (not a tool_result BLOCK inside 'user',
 *                        the way Claude nests it) — so no blockRole() reclassification
 *                        is needed here; the envelope already says what it is.
 * toolName/toolCallId live on the message envelope for a toolResult, and name/arguments
 * live directly on a 'toolCall' block — neither matches Claude's tool_use/tool_result
 * field layout, so this gets its own flatten function rather than reusing
 * flattenContent/blockRole, which are typed to Claude's exact block vocabulary.
 */

const INDEXED = new Set(["user", "assistant", "toolResult"]);

function flattenOmp(content: unknown): { text: string; role: string | null } {
  if (!Array.isArray(content)) return { text: "", role: null };
  const kinds = new Set<string>();
  const out: string[] = [];
  for (const raw of content) {
    const item = asObj(raw);
    if (!item) continue;
    const t = str(item.type);
    if (t) kinds.add(t);
    if (t === "text") {
      const txt = str(item.text);
      if (txt) out.push(txt);
    } else if (t === "thinking") {
      const th = str(item.thinking);
      if (th) out.push(th);
    } else if (t === "toolCall") {
      out.push(`[tool_use ${str(item.name) ?? "?"}] ${truncate(JSON.stringify(item.arguments ?? {}), 2000)}`);
    }
  }
  // Same "label by what the block actually is" rule as Claude — see blockRole()'s
  // comment in types.ts. A content array holding ONLY toolCall/thinking blocks is
  // tool traffic or reasoning, not conversation, whichever envelope role carried it.
  let role: string | null = null;
  if (kinds.has("toolCall") && !kinds.has("text")) role = "tool_use";
  else if (kinds.has("thinking") && kinds.size === 1) role = "thinking";
  return { text: out.join("\n"), role };
}

export const parseOmp: Parser = async (filePath) => {
  const fileKey = basename(filePath);
  const events: ParsedEvent[] = [];
  const typeCounts: Record<string, number> = {};
  let lines = 0, badLines = 0, seq = 0;
  let cwd: string | null = null, model: string | null = null;
  // omp's own id field is the session identity — the filename ALSO embeds it after
  // the timestamp prefix, but the "session" record is the source of truth.
  let sessionUuid = fileKey.replace(/\.jsonl$/, "");
  let startedAt: string | null = null, endedAt: string | null = null;
  let description: string | null = null, title: string | null = null;

  const rl = createInterface({ input: createReadStream(filePath, "utf8") });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    lines++; seq++;

    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { badLines++; continue; }
    const rec = asObj(parsed);
    if (!rec) { badLines++; continue; }

    const type = str(rec.type) ?? "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;

    if (type === "session") {
      if (!cwd) cwd = str(rec.cwd);
      const id = str(rec.id);
      if (id) sessionUuid = id;
    }
    if (type === "model_change" && !model) model = str(rec.model);
    // Overwrite, never keep-first — same reasoning as Claude's ai-title: the title
    // is refined as the session goes on, so the LAST one names what it became.
    if ((type === "title" || type === "title_change") && !title) {
      const t = str(rec.title);
      if (t) title = t;
    }

    const ts = str(rec.timestamp);
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }

    if (!INDEXED.has(type === "message" ? str(asObj(rec.message)?.role) ?? "" : "")) continue;

    const msg = asObj(rec.message);
    const envelopeRole = str(msg?.role);
    if (!envelopeRole) continue;

    const { text, role: blockRole } = flattenOmp(msg?.content);
    if (!text) continue;

    const role = blockRole ?? (envelopeRole === "toolResult" ? "tool_result" : envelopeRole);

    if (!description && role === "user") description = truncate(text, 200);
    events.push({
      uid: uidOf("omp", fileKey, seq),
      seq, role, ts, text: truncate(text),
    });
  }

  return { sessionUuid, cwd, model, events, lines, badLines, typeCounts, startedAt, endedAt,
           description, title, gitBranch: null };
};
