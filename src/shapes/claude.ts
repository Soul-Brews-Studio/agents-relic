import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { asObj, str, truncate, flattenContent, blockRole, uidOf, type ParsedEvent, type ParsedFile, type Parser } from "../types.js";

/** Roles whose text is worth full-text indexing. UI/state events are counted, not indexed. */
const INDEXED = new Set(["user", "assistant", "system"]);

/**
 * Claude Code transcripts — ~/.claude/projects/<encoded>/<uuid>.jsonl and its
 * subagent / workflow-agent children. One JSON object per line, and the whole file
 * is transcript (unlike Codex, where only one record type is).
 */
export const parseClaude: Parser = async (filePath) => {
  const fileKey = basename(filePath);
  const events: ParsedEvent[] = [];
  const typeCounts: Record<string, number> = {};
  let lines = 0, badLines = 0, seq = 0;
  let cwd: string | null = null, model: string | null = null;
  let sessionUuid = fileKey.replace(/\.jsonl$/, "");
  let startedAt: string | null = null, endedAt: string | null = null;
  let description: string | null = null;

  const rl = createInterface({ input: createReadStream(filePath, "utf8") });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;          // seq counts NON-EMPTY lines only — see `show`
    lines++; seq++;

    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); } catch { badLines++; continue; }
    const rec = asObj(parsed);
    if (!rec) { badLines++; continue; }

    const type = str(rec.type) ?? "unknown";
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;

    // cwd comes from the session's own field, never decoded from the directory name:
    // the encoding maps BOTH "/" and "." to "-", so it is lossy and not reversible.
    if (!cwd) cwd = str(rec.cwd);
    if (!/^[0-9a-f-]{36}$/.test(sessionUuid)) sessionUuid = str(rec.sessionId) ?? sessionUuid;

    const ts = str(rec.timestamp);
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }

    if (!INDEXED.has(type)) continue;

    const msg = asObj(rec.message);
    if (!model) model = str(msg?.model);
    const raw = msg?.content ?? rec.content ?? "";
    const text = flattenContent(raw).trim();
    if (!text) continue;

    // Label by what the block ACTUALLY is, not by the envelope that carried it.
    //
    // Claude delivers a tool result as a `user` message whose content is a
    // tool_result block — so taking the envelope role at face value files machine
    // output as something the human said. Measured on one shard before this fix:
    // 68.5% of indexed text was tool-output-shaped while only 3.7% carried the
    // tool_result role. That buries human prose under command output in every
    // ranked search, and it is why a search for a term printed by a tool ranks the
    // tool's own output first.
    const role = blockRole(raw) ?? str(msg?.role) ?? type;

    if (!description && role === "user") description = truncate(text, 200);
    events.push({
      uid: uidOf("claude", fileKey, seq),   // path-independent by design
      seq, role, ts, text: truncate(text),
    });
  }

  return { sessionUuid, cwd, model, events, lines, badLines, typeCounts, startedAt, endedAt, description };
};
