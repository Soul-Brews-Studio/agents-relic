import { LanceStore, sqlStr, type EventRow } from "./store/lance.js";
import { pickShards, resolveSession, nameOf, type Scope } from "./query.js";
import { isHostPreamble } from "./types.js";

/**
 * What HAPPENED in one session, as a projection of indexed rows.
 *
 * `relic session <id>` answers "what shape is this session" — transcripts, tiers,
 * counts, the tree. It says nothing about CONTENT, so answering "what did that session
 * actually do" meant reading a 12 MB transcript. This is the missing half, and it needs
 * no summarisation: the index already holds the human's turns, the tool calls, and the
 * closing message. Recap is a query, not a generation.
 *
 * MAIN TIER ONLY by default. A session's subagents restate its instructions and talk to
 * themselves; including them buries the human's actual thread, which is the one thing a
 * recap is for. `allTiers` gets them back.
 */

export interface RecapTurn { ts: string; text: string }
export interface SessionRecap {
  sessionUuid: string; name: string; repo: string; bank: string;
  startedAt: string; endedAt: string; model: string; gitBranch: string;
  transcripts: number; events: number;
  roles: { role: string; n: number }[];
  asked: RecapTurn[];               // the human's turns, boilerplate removed
  askedOmitted: number;             // how many turns were dropped as boilerplate
  tools: { name: string; n: number }[];
  files: { path: string; n: number }[];
  endedWith: string;                // the last assistant turn
}

/** `[tool_use Bash] {...}` -> "Bash". The name is the useful part; the input is not. */
const TOOL = /^\[tool_use ([\w.:-]+)\]/;
/** Edit/Write inputs carry the path. Truncated JSON still contains it — it comes first. */
const FILE = /"file_path"\s*:\s*"([^"]+)"/;

/**
 * Turns that are the HOST talking, not the human.
 *
 * Three shapes, all measured in the corpus: a slash command's own expansion
 * (`<command-message>`), the skill body the harness pastes in after it
 * ("Base directory for this skill:"), and the host preambles isHostPreamble already
 * knows. Without this the spine of a recap is the tooling describing itself — 5 of the
 * first 5 user turns in the session this was built against.
 */
export function isHarnessTurn(t: string): boolean {
  if (isHostPreamble(t)) return true;
  return /^<command-(message|name|args)>/.test(t)
      || /^Base directory for this skill:/.test(t)
      || /^<local-command-(caveat|stdout)>/.test(t)
      || /^Caveat: The messages below were generated/.test(t)
      || /^<system-reminder>/.test(t)
      /*
       * Shell OUTPUT, not the human. When a `!`-prefixed command runs, the harness
       * writes both the command and its output to the user channel:
       *
       *     <bash-input>ls</bash-input>        <- the human typed this: KEEP
       *     <bash-stdout>ψ\nCLAUDE.md\n…      <- the machine answered:  DROP
       *
       * Dropping both would lose a real turn; keeping both puts a directory listing
       * in "what was asked". Found by reading `relic tail --role user` on this
       * session and seeing two `ls` listings in the human's last twelve turns.
       */
      || /^<bash-stdout>/.test(t)
      || /^<bash-stderr>/.test(t)
      // The harness announcing a background task finished. Arrives as a user turn and
      // is never something a person typed.
      || /^<task-notification>/.test(t)
      /*
       * ANOTHER AGENT REPORTING IN, not the human. A subagent's result is delivered
       * on the user channel with this preamble, so a session that fans out to four
       * workers collects a dozen of them.
       *
       * Found by running `relic tail --handoff` on the session that built it: 5 of
       * 14 "human turns" were workers announcing PRs. They corrupt two things at
       * once — the turn count, and the pacing. Agents report on agent time, so a
       * 55-second median gap was measuring subagent latency and calling it the
       * human's focus, which is the one number --handoff exists to get right.
       */
      || /^Another Claude session sent a message:/.test(t)
      || /^<teammate-message\b/.test(t)
      // The resume prompt after a compaction. It IS in the user channel, but it is the
      // harness restarting the session, not a new instruction — and in a long-running
      // session it appears once per compaction, outnumbering real turns.
      || /^Continue from where you left off\.?$/.test(t.trim())
      || /^This session is being continued from a previous conversation/.test(t);
}

const clean = (t: string) => t.replace(/\s+/g, " ").trim();

export async function sessionRecap(
  idOrPrefix: string,
  o: Scope & { limit?: number; allTiers?: boolean; chars?: number } = {},
): Promise<SessionRecap | null> {
  const found = await resolveSession(idOrPrefix, o);
  const rows = found?.rows ?? [];
  if (!rows.length) return null;

  // The parent row is the session itself; children are its subagents.
  const parent = rows.find(r => r.tier === "session") ?? rows[0];
  const uuid = String(parent.session_uuid);
  const shards = pickShards({ ...o, repo: o.repo ?? undefined });

  const events: EventRow[] = [];
  for (const sh of shards) {
    try {
      const st = await LanceStore.open(sh.dir);
      const where = `session_uuid = ${sqlStr(uuid)}` +
                    (o.allTiers ? "" : ` AND tier = ${sqlStr("session")}`);
      for (const r of await st.eventsWhere(where)) events.push(r as unknown as EventRow);
    } catch { /* a shard mid-write can throw; skip rather than abort */ }
  }
  if (!events.length) return null;
  events.sort((a, b) => Number(a.seq) - Number(b.seq));

  const roles = new Map<string, number>();
  const tools = new Map<string, number>();
  const files = new Map<string, number>();
  const asked: RecapTurn[] = [];
  let askedOmitted = 0, endedWith = "";
  const chars = o.chars ?? 140;

  for (const e of events) {
    const role = String(e.role || "?"), text = String(e.text ?? "");
    roles.set(role, (roles.get(role) ?? 0) + 1);
    if (role === "user") {
      if (isHarnessTurn(text)) { askedOmitted++; continue; }
      asked.push({ ts: String(e.ts ?? ""), text: clean(text).slice(0, chars) });
    } else if (role === "tool_use") {
      const n = text.match(TOOL)?.[1];
      if (n) tools.set(n, (tools.get(n) ?? 0) + 1);
      if (/^\[tool_use (Edit|Write|MultiEdit|NotebookEdit)\]/.test(text)) {
        const f = text.match(FILE)?.[1];
        if (f) files.set(f, (files.get(f) ?? 0) + 1);
      }
    } else if (role === "assistant") {
      const c = clean(text);
      if (c) endedWith = c.slice(0, 400);      // last one wins — events are seq-ordered
    }
  }

  const desc = (m: Map<string, number>) =>
    [...m].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ name: k, n }));

  return {
    sessionUuid: uuid,
    name: nameOf({ title: (parent as any).title, description: (parent as any).description }),
    repo: String((found as any)?.repo ?? (parent as any).repo_key ?? ""),
    bank: String((parent as any).bank ?? ""),
    startedAt: String(parent.started_at ?? ""), endedAt: String(parent.ended_at ?? ""),
    model: String(parent.model ?? ""), gitBranch: String((parent as any).git_branch ?? ""),
    transcripts: rows.length, events: events.length,
    roles: [...roles].sort((a, b) => b[1] - a[1]).map(([role, n]) => ({ role, n })),
    asked: o.limit ? asked.slice(0, o.limit) : asked,
    askedOmitted,
    tools: desc(tools).slice(0, 12),
    files: [...files].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([path, n]) => ({ path, n })),
    endedWith,
  };
}

/**
 * How many characters a turn gets in `relic tail --handoff`.
 *
 * Asymmetric on purpose. The human's turn is the content; the assistant's is the
 * context that makes "go" mean something, and context does not need the same room as
 * content. Half, with a floor — below about 60 characters an assistant turn is cut
 * before it says what it proposed, which is the one job it is there to do.
 */
export function handoffBudget(role: string, chars: number): number {
  return role === "user" ? chars : Math.max(60, Math.round(chars / 2));
}

/**
 * A hidden turn that starts a NEW exchange, rather than one caused by the human's.
 *
 * Both kinds are stripped from what a reader sees, but they mean opposite things for
 * pairing, and conflating them loses a reply either way:
 *
 *   caused by the human    <bash-input>ls</bash-input>   the human typed this
 *                          <bash-stdout>…                the machine answered
 *                          "here is what that listed"    STILL the human's exchange
 *
 *   independent inbound    <teammate-message …>          a worker reporting in
 *                          "PR #52 — vaults finished"    NOT the human's exchange
 *
 * Break on the second kind only. Breaking on both orphaned every reply that followed a
 * bash-stdout or a skill body; breaking on neither paired "suggest me" with a PR
 * report it had nothing to do with. Both were seen on one real session.
 */
export function isInboundTurn(t: string): boolean {
  return /^Another Claude session sent a message:/.test(t)
      || /^<teammate-message\b/.test(t)
      || /^<task-notification>/.test(t)
      || /^Continue from where you left off\.?$/.test(t.trim())
      || /^This session is being continued from a previous conversation/.test(t);
}
