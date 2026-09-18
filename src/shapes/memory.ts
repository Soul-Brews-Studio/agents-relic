import { readFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { truncate, uidOf, type ParsedEvent, type Parser } from "../types.js";
import { seekOnDisk } from "../seek.js";
import { cwdOfFile } from "../repo.js";

/**
 * Claude Code's own memory store — `~/.claude/projects/<encoded>/memory/*.md`.
 *
 * A THIRD kind of thing, distinct from the two relic already holds:
 *
 *   transcript   what was said, in order, with turns
 *   vault note   a document someone wrote
 *   memory       a single durable FACT the agent chose to keep, typed, with a
 *                pointer back to the session that produced it
 *
 * Measured across this machine before building: 67 memory directories, 227 files,
 * 172 carrying a typed frontmatter — project 64, feedback 53, reference 49, user 6 —
 * and 161 carrying `originSessionId`. That last field is why this is worth indexing
 * separately: it JOINS a memory to the session that created it, which no other source
 * can answer.
 *
 * MEMORY.md is skipped: it is an index of the others, so indexing it duplicates every
 * memory's description as a second hit.
 */

const TYPES = new Set(["project", "feedback", "reference", "user"]);

interface Front { fields: Record<string, string>; body: string }

/**
 * Flat `key: value`, plus the one nested block Claude Code writes (`metadata:`).
 *
 * Not a YAML parser, for the same reason as the vault shape: the format is flat
 * enough that a dependency would buy nothing. Nested keys are flattened with their
 * own name only (`type`, `originSessionId`), which is unambiguous here because the
 * only nesting is under `metadata:`.
 */
function frontMatter(text: string): Front {
  if (!text.startsWith("---")) return { fields: {}, body: text };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fields: {}, body: text };

  const fields: Record<string, string> = {};
  for (const line of text.slice(3, end).split("\n")) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (v) fields[m[1]] = v;
  }
  return { fields, body: text.slice(end + 4).replace(/^\n+/, "") };
}

/**
 * Which repo does this memory belong to?
 *
 * NOT by decoding the `<encoded>` directory name — that maps both "/" and "." to "-"
 * and is not reversible; relic refuses to decode it anywhere else and this is no
 * exception. Instead follow `originSessionId` to the real transcript and read the cwd
 * the session itself recorded.
 *
 * Falls back to null (shard `_unresolved`) rather than guessing, which is the honest
 * outcome for a memory whose origin session has been pruned.
 */
async function cwdFromOrigin(sessionId: string | undefined): Promise<string | null> {
  if (!sessionId) return null;
  try {
    const found = seekOnDisk(sessionId);
    const parent = found.find(f => f.tier === "session") ?? found[0];
    return parent ? await cwdOfFile(parent.path) : null;
  } catch { return null; }
}

export const parseMemory: Parser = async (filePath) => {
  const name = basename(filePath, ".md");
  let text = "";
  try { text = readFileSync(filePath, "utf8"); } catch { /* unreadable -> empty */ }

  const { fields, body } = frontMatter(text);
  const type = TYPES.has(fields.type) ? fields.type : "";
  const origin = fields.originSessionId || "";

  // `modified` is the agent's own record of when it last revised the fact; file mtime
  // changes for reasons that are not revisions (a copy, a sync), so prefer the field.
  let ts = "";
  if (fields.modified) {
    const t = Date.parse(fields.modified);
    if (!Number.isNaN(t)) ts = new Date(t).toISOString();
  }
  if (!ts) { try { ts = new Date(statSync(filePath).mtimeMs).toISOString(); } catch {} }

  const cwd = await cwdFromOrigin(origin);

  // The description is the retrieval surface Claude Code itself uses to decide
  // relevance, so it leads the indexed text rather than being dropped as metadata.
  const head = [fields.description, type ? `[${type}]` : ""].filter(Boolean).join(" ");
  const full = [head, body.trim()].filter(Boolean).join("\n\n");

  const events: ParsedEvent[] = [{
    uid: uidOf("memory", filePath, 0),
    seq: 0,
    role: "memory",
    ts,
    text: truncate(full),
  }];

  return {
    sessionUuid: fields.name || name,
    cwd,
    model: null,
    events,
    lines: text.split("\n").length,
    badLines: 0,
    typeCounts: { [type || "untyped"]: 1 },
    startedAt: ts,
    endedAt: ts,
    description: fields.description || body.trim().slice(0, 200) || null,
    title: fields.name || name,
    gitBranch: null,
    // Carried so the importer can store it without re-parsing.
    memType: type,
    originSessionId: origin,
    memoryDir: dirname(filePath),
  } as any;
};
