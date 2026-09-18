import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import { asObj, str, truncate, uidOf, type ParsedEvent, type ParsedFile, type Parser } from "../types.js";

/**
 * Codex CLI rollouts — ~/.codex/sessions/**\/rollout-*.jsonl
 *
 * Structurally unlike Claude: the file is a stream of MIXED record types and only
 * `response_item` carries transcript. `event_msg` and `token_usage_record` are UI
 * bookkeeping and are counted but never indexed — indexing them floods search with
 * noise that looks like conversation.
 */
export const parseCodex: Parser = async (filePath) => {
  const fileKey = basename(filePath);
  const events: ParsedEvent[] = [];
  const typeCounts: Record<string, number> = {};
  let lines = 0, badLines = 0, seq = 0;
  let cwd: string | null = null, model: string | null = null;
  // Fallback identity: a rollout truncated before its session_meta line still needs a stable id.
  let sessionUuid = fileKey.replace(/^rollout-/, "").replace(/\.jsonl$/, "");
  let startedAt: string | null = null, endedAt: string | null = null;
  let description: string | null = null;

  const push = (role: string, text: string, ts: string | null, partIdx: number) => {
    const t = text.trim();
    if (!t) return;
    if (!description && role === "user") description = truncate(t, 200);
    events.push({ uid: uidOf("codex", fileKey, seq * 1000 + partIdx), seq, role, ts, text: truncate(t) });
  };

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
    const ts = str(rec.timestamp);
    if (ts) { if (!startedAt) startedAt = ts; endedAt = ts; }

    const payload = asObj(rec.payload);
    if (!payload) continue;

    if (type === "session_meta") {
      sessionUuid = str(payload.id) ?? str(payload.session_id) ?? sessionUuid;
      cwd = str(payload.cwd) ?? cwd;
      continue;
    }
    if (type === "turn_context") {
      model = model ?? str(payload.model);
      cwd = cwd ?? str(payload.cwd);
      continue;
    }
    if (type !== "response_item") continue;   // event_msg / token_usage_record are UI noise

    const ptype = str(payload.type);
    if (ptype === "message" || ptype === "agent_message") {
      const role = ptype === "agent_message" ? "assistant" : (str(payload.role) ?? "unknown");
      if (Array.isArray(payload.content)) {
        let i = 0;
        for (const raw of payload.content) {
          const item = asObj(raw);
          const t = item ? (str(item.text) ?? "") : "";
          if (t) push(role, t, ts, i);
          i++;
        }
      } else {
        push(role, str(payload.message) ?? str(payload.text) ?? "", ts, 0);
      }
    } else if (ptype === "reasoning") {
      // Codex emits reasoning as its own record type. Kept as a distinct role so it can
      // be searched — or excluded — separately. Claude's shape has no equivalent.
      const parts: string[] = [];
      if (Array.isArray(payload.summary)) {
        for (const raw of payload.summary) {
          const s = asObj(raw);
          const t = s ? (str(s.text) ?? "") : "";
          if (t) parts.push(t);
        }
      }
      push("reasoning", parts.join("\n"), ts, 0);
    } else if (ptype === "custom_tool_call" || ptype === "function_call") {
      const name = str(payload.name) ?? "tool";
      const input = str(payload.input) ?? str(payload.arguments) ?? "";
      push("tool_use", `[tool_call ${name}] ${truncate(input, 2000)}`, ts, 0);
    } else if (ptype === "custom_tool_call_output" || ptype === "function_call_output") {
      push("tool_result", `[tool_output] ${truncate(str(payload.output) ?? "", 4000)}`, ts, 0);
    }
  }

  // Codex rollouts carry no title record — the caller falls back to description.
  return { sessionUuid, cwd, model, events, lines, badLines, typeCounts, startedAt, endedAt, description, title: null, gitBranch: null };
};
