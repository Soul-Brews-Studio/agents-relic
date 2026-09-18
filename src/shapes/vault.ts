import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { truncate, uidOf, type ParsedEvent, type Parser } from "../types.js";

/**
 * Oracle vault notes — `ψ/**` markdown.
 *
 * Not a transcript. A note is a DOCUMENT: no turns, no roles, no session. It is
 * mapped onto the same `events` schema anyway, so `search`, `show`, `sessions` and
 * every MCP tool work on it unchanged — adding a second table would have meant a
 * second query path in all of them.
 *
 * Measured over 10,058 real vault files (node_modules/.git excluded) before choosing
 * the granularity:
 *
 *   `##` sections per file   avg 0.6      -> chunking by heading is WRONG; most notes
 *                                            have zero or one section
 *   under 4 KB               9,475 (94%)  -> a whole note fits in one row comfortably
 *   over MAX_TEXT (16 KB)      121 (1.2%) -> only these need splitting
 *   with YAML frontmatter    9,304 (92%)  -> frontmatter is the norm, worth parsing
 *
 * So: ONE ROW PER NOTE, and split only the 1.2% that would otherwise truncate.
 */

/** Frontmatter fields worth keeping as filterable text rather than discarding. */
interface FrontMatter {
  fields: Record<string, string>;
  body: string;
  /** Raw block, kept so search can still match on it. */
  raw: string;
}

/**
 * Split a leading `---` YAML block off the body.
 *
 * Deliberately NOT a YAML parser: the vault's frontmatter is flat `key: value` with
 * occasional `[a, b]` lists, and pulling in a YAML dependency to read that would be
 * a parser and a supply-chain risk for no gain. Anything it cannot parse stays in
 * `raw`, which is still indexed — so a miss degrades to "searchable but not
 * filterable", never to "lost".
 */
function frontMatter(text: string): FrontMatter {
  if (!text.startsWith("---")) return { fields: {}, body: text, raw: "" };
  const end = text.indexOf("\n---", 3);
  if (end < 0) return { fields: {}, body: text, raw: "" };

  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\n+/, "");
  const fields: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;                       // nested/multiline value — stays in raw
    const v = m[2].trim().replace(/^["']|["']$/g, "");
    if (v) fields[m[1]] = v;
  }
  return { fields, body, raw };
}

/**
 * Split an oversized note on `##` boundaries, falling back to a hard cut.
 *
 * Only reached by ~1.2% of files. The fallback matters: a 40 KB note with no headings
 * exists (generated reports), and without it the tail would silently vanish at
 * MAX_TEXT — the same class of silent-truncation bug this codebase has already been
 * bitten by.
 */
function chunk(body: string, max: number): string[] {
  if (body.length <= max) return [body];

  const out: string[] = [];
  let cur = "";
  for (const part of body.split(/\n(?=## )/)) {
    if (cur && cur.length + part.length > max) { out.push(cur); cur = ""; }
    if (part.length > max) {
      if (cur) { out.push(cur); cur = ""; }
      for (let i = 0; i < part.length; i += max) out.push(part.slice(i, i + max));
      continue;
    }
    cur = cur ? `${cur}\n${part}` : part;
  }
  if (cur) out.push(cur);
  return out;
}

/** Notes have no clock of their own; frontmatter date beats file mtime. */
function timestampOf(fields: Record<string, string>, filePath: string): string {
  const d = fields.date || fields.created_at || fields.updated;
  if (d) {
    const t = Date.parse(d);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  try { return new Date(statSync(filePath).mtimeMs).toISOString(); } catch { return ""; }
}

export const parseVault: Parser = async (filePath) => {
  const fileKey = basename(filePath);
  let text = "";
  try { text = readFileSync(filePath, "utf8"); } catch { /* unreadable -> empty note */ }

  const { fields, body, raw } = frontMatter(text);
  const ts = timestampOf(fields, filePath);
  const title = fields.name || fields.title || fields.pattern || null;

  // Frontmatter is prepended to the FIRST chunk's text rather than dropped, so a
  // search for a concept tag or a pattern line still hits even though the fields are
  // also stored separately.
  const chunks = chunk(body.trim(), 15_000);
  const events: ParsedEvent[] = chunks.map((c, i) => ({
    uid: uidOf("vault", fileKey, i),
    seq: i,
    role: "note",
    ts,
    text: truncate(i === 0 && raw ? `${raw}\n\n${c}` : c),
  }));

  // A note with no body still deserves a row — an empty stub is a real vault state
  // (a placeholder someone made and never filled), and dropping it makes the index
  // disagree with the filesystem about what exists.
  if (!events.length) {
    events.push({ uid: uidOf("vault", fileKey, 0), seq: 0, role: "note", ts, text: raw });
  }

  return {
    // The path IS the identity for a document — there is no uuid to read.
    sessionUuid: filePath,
    // A note has no cwd of its own, but its PATH already contains
    // `github.com/<org>/<repo>`, which is exactly what repoKeyOf reads. Passing the
    // path here shards each note into its owning oracle's repo alongside that repo's
    // transcripts. Leaving it null would file the entire vault under `_unresolved`.
    cwd: filePath,
    model: null,
    events,
    lines: text.split("\n").length,
    badLines: 0,
    typeCounts: { note: events.length },
    startedAt: ts,
    endedAt: ts,
    description: (fields.description || body.trim().slice(0, 200)) || null,
    title,
    gitBranch: null,
  };
};
