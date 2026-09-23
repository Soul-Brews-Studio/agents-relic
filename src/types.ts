import { createHash } from "node:crypto";

/** One indexable line of a transcript. */
export interface ParsedEvent {
  uid: string;      // stable, path-independent: the same file under two roots dedups
  seq: number;      // Nth non-empty line — the jump-to key back into the file
  role: string;     // user | assistant | system | reasoning | tool_use | tool_result
  ts: string | null;
  text: string;
  /**
   * The cwd RECORDED ON THIS LINE, which is not always the session's first one.
   *
   * The source writes cwd per record; relic used to keep the first and stamp it on
   * every event. Measured on session 2bb9b553: 3,867 events in `ansible-oracle` and
   * 201 in `neo-oracle/wt/neo-arra-oracle-v4`, all filed under the first repo, so
   * `--worktree neo-arra-oracle-v4` could not reach them at all.
   *
   * FINDABLE, NOT ATTRIBUTABLE — and the distinction is the whole design. The 201
   * events stay in the shard their session was filed under; they only become
   * reachable by cwd. Sharding per event would split 4 of 542 transcripts and force
   * a union in `relic session <id>` on the other 538. Bad trade:
   *
   *     542 live transcripts · >1 cwd: 83 (15.3%) · >1 REPO: 4 (0.7%)
   *
   * Consequence to expect: on those 4, `cwd` disagrees with `repo_key`. Intended.
   * Rows written before this keep the stamped value until a rebuild.
   *
   * OPTIONAL because only the Claude shape records cwd per line. Codex rollouts,
   * vault notes, omp and hermes have one cwd for the whole file or none, so they
   * leave it unset and the importer falls back to the file's. Typing it as required
   * would force four shapes to write a value they do not have.
   */
  cwd?: string | null;
  /**
   * Who sent this turn, from which room, and when — set only on a user turn that OPENS
   * with a channel envelope (see parseChannelEnvelope). `text` keeps the envelope.
   */
  channel?: ChannelEnvelope | null;
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

// Tags whose content later code reads: slash-command promotion and the caveat drop.
const STRUCTURAL_TAGS = new Set([
  "command-name", "command-message", "command-args",
  "local-command-caveat", "local-command-stdout", "local-command-stderr",
]);

// The channel tag itself, open or close, anywhere in the text (from #80). Followed by space
// or `>`, so a `<channel-id>` placeholder in quoted CLI usage is left alone.
const CHANNEL_TAG = /<\/?channel(?=[\s>])[^>]*>/gi;

// Host envelopes, wrapped text kept. Leading: any tag of any length, cut-off ones included
// (<channel …>, <teammate-message …>, <hook_prompt …>). Anywhere: channel tags only.
export function stripEnvelope(text: string): string {
  const raw = String(text ?? "");
  let t = raw;
  for (let i = 0; i < 8; i++) {
    const m = /^\s*<([a-zA-Z][\w-]*)\b[^>]*(?:>|$)/.exec(t);
    if (!m || STRUCTURAL_TAGS.has(m[1].toLowerCase()) || isHostPreamble(t)) break;
    t = t.slice(m[0].length);
    const close = t.indexOf(`</${m[1]}>`);
    if (close >= 0) t = t.slice(0, close) + " " + t.slice(close + m[1].length + 3);
  }
  t = t.replace(CHANNEL_TAG, " ");
  return t === raw ? raw : t.trim();
}

/**
 * What a channel plugin's envelope says about a turn, and the only place it is said:
 * who sent it, from which room, on whose clock (#85, #86). "" for an absent attribute.
 */
export interface ChannelFacets {
  via: string;            // `source`, VERBATIM: plugin:discord:discord, arra-oracle-discord, mqtt …
  chat_id: string;        // the channel or thread it arrived in
  msg_id: string;         // `message_id` — the message upstream
  from_user: string;      // `user`
  from_user_id: string;   // `user_id`
  sent_ts: string;        // `ts` — the sender's clock, not the transcript's
}
export interface ChannelEnvelope extends ChannelFacets { body: string }

const CHANNEL_OPEN = /^\s*<channel(?=[\s>])([^>]*)(?:>|$)/;

/**
 * A channel delivery's facets, or null when the text is not one.
 *
 * A DELIVERY OPENS THE TURN. Measured on m5: of 3,474 user turns holding a `<channel`
 * tag, 3,377 open with one, each with exactly one envelope. The other 97 are quoted
 * text — compaction summaries, pasted prompts, federation messages — and parsing those
 * would credit a Discord user with a paragraph an agent pasted. `source` is required:
 * a bare `<channel>` is prose about the tag (48 of them).
 *
 * Tolerant of truncation. A tag cut off before its `>` keeps every attribute that
 * survived whole, and a missing one is "" — a half-written id is not an id. `body` is
 * stripEnvelope's, so there is one idea of what an envelope wraps, not two. Like
 * stripEnvelope, the tag ends at its first `>`: 0 of 3,377 real envelopes quote one.
 */
export function parseChannelEnvelope(text: string): ChannelEnvelope | null {
  const m = CHANNEL_OPEN.exec(String(text ?? ""));
  if (!m) return null;
  const a = new Map<string, string>();
  for (const [, k, v] of m[1].matchAll(/([\w-]+)="([^"]*)"/g)) if (!a.has(k)) a.set(k, v);
  if (!a.get("source")) return null;
  const at = (k: string) => a.get(k) ?? "";
  return { via: at("source"), chat_id: at("chat_id"), msg_id: at("message_id"),
           from_user: at("user"), from_user_id: at("user_id"), sent_ts: at("ts"), body: stripEnvelope(text) };
}

/** `plugin:discord:discord` -> `discord`. Display only; the column keeps the raw value. */
export function viaLabel(via: string): string {
  return /^plugin:[^:]*:(.+)$/.exec(via)?.[1] ?? via;
}

/** `nazt_ (discord)` — who said it, and through what. All a human turn needs in a margin. */
export function senderOf(c: ChannelFacets): string {
  return c.from_user ? `${c.from_user} (${viaLabel(c.via)})` : viaLabel(c.via);
}

/** A human turn as a reader should see it: `nazt_ (discord): yo` for a delivery, else as typed. */
export function saidText(text: string): string {
  const c = parseChannelEnvelope(text);
  return c ? `${senderOf(c)}: ${c.body}` : text;
}
