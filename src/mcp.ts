#!/usr/bin/env bun
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  searchEvents, listSessions, resolveSession, chainOf, readAround, indexStatus, pickShards,
  statsOf, neighbours, nameOf,
} from "./query.js";
import { renderChain } from "./chain.js";
import { localDateTime, localTime, zoneOffset, zoneName } from "./time.js";
import { currentSession, liveSessions, treeFiles, activityBuckets, sparkline, humanAge } from "./live.js";
import { trace } from "./trace.js";

/**
 * relic over MCP — the same lookups the CLI exposes, as tools a model can call.
 *
 * The point is that a MODEL SHOULD NOT IMPROVISE A QUERY. Without these tools, finding
 * a session means guessing at a `find` or a `grep -r` over 25k transcripts: slow, often
 * wrong, and different every time. Each tool here is one deterministic lookup with named
 * parameters, so the same question gives the same answer whoever asks it.
 *
 * Every handler calls src/query.ts — the SAME functions the CLI renders. Nothing is
 * reimplemented for MCP, because a second copy of a query drifts, and the copy a model
 * gets is the one no human ever runs by hand.
 *
 * Run:  bun src/mcp.ts            (stdio)
 *       claude mcp add relic -- bun /path/to/agents-relic/src/mcp.ts
 */

const DATA_ROOT = process.env.RELIC_DATA_ROOT || null;
const IN_REPO = process.env.RELIC_IN_REPO === "1";
const scopeOf = (a: any) => ({ dataRoot: DATA_ROOT, inRepo: IN_REPO, repo: a?.repo || undefined });

/**
 * A fan-out over every shard is the expensive case — measured at 10.7 s across 345
 * shards, against ~200 ms for one. `repo` is therefore named in every description that
 * accepts it, so the model narrows by default instead of paying for the sweep.
 */
const REPO_DESC = "Substring of the repo key, e.g. 'neo-oracle'. STRONGLY RECOMMENDED: " +
  "without it the query fans out over every indexed repo (seconds, not milliseconds). " +
  "Call relic_status to see which repos exist.";
const SINCE_DESC = "Relative span (7d, 12h, 30m), a date (2026-09-01), or a full ISO timestamp.";

const str = (d: string) => ({ type: "string" as const, description: d });
const num = (d: string) => ({ type: "number" as const, description: d });

const TOOLS = [
  {
    name: "relic_search",
    description:
      "Full-text search across indexed agent session transcripts (Claude Code + Codex), " +
      "BM25-ranked. Finds what was SAID — a decision, an error, a command, a discussion. " +
      "Matches inside words, so Thai and other unspaced scripts work. " +
      "Returns a pointer (file + seq) per hit; use relic_show to read the conversation around one.",
    inputSchema: {
      type: "object",
      properties: {
        query: str("Words to find. Not a regex and not SQL — plain terms."),
        repo: str(REPO_DESC),
        limit: num("Max hits (default 20)."),
        role: str("user | assistant | thinking | tool_use | tool_result | system. " +
                  "'user' and 'assistant' are what a human and the model actually said."),
        prose: { type: "boolean" as const, description:
          "Only conversation (user/assistant/thinking), excluding tool traffic. " +
          "Use when looking for a decision or explanation rather than a command." },
        tier: str("session (the human's conversation) | subagent | workflow_agent."),
        source: str("Which corpus a transcript came from — see relic_status."),
        worktree: str("Worktree name, when the repo uses them."),
        path: str("Substring of the transcript's file path."),
        since: str(SINCE_DESC),
        until: str(SINCE_DESC),
      },
      required: ["query"],
    },
  },
  {
    name: "relic_sessions",
    description:
      "List or count indexed sessions, newest first, each with its NAME (the title the " +
      "host assigned, falling back to the opening user message). " +
      "Answers 'what was I working on' over a time range. Filters on the session's own " +
      "first timestamp, not file mtime — an old session that got one new line stays old.",
    inputSchema: {
      type: "object",
      properties: {
        repo: str(REPO_DESC),
        since: str(SINCE_DESC),
        until: str(SINCE_DESC),
        worktree: str("Worktree name."),
        limit: num("Max rows (default 40)."),
      },
    },
  },
  {
    name: "relic_session",
    description:
      "Look up one session by id OR BY NAME, and describe it: totals, tier breakdown, " +
      "workflow-run count, its transcripts, and the sessions either side of it in the " +
      "same worktree. A session uuid names a TREE — the parent conversation plus its " +
      "subagent and workflow-agent children — so this describes many files, not one. " +
      "An unindexed id is located on disk and imported first, so this does not fail " +
      "with 'run index first'. If a name matches several sessions, all are listed for " +
      "you to choose from.",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Session uuid, a prefix of it ('04d1d650'), or the session's NAME — " +
                "matched against the title the host assigned and the opening message, " +
                "case-insensitive substring, e.g. 'ralph-dig'."),
        repo: str("Repo filter. Unnecessary for an id; RECOMMENDED for a name, which " +
                  "otherwise searches every indexed repo."),
        limit: num("Max transcripts listed (default 10). Stats always cover all of them."),
        neighbours: { type: "boolean" as const, description:
          "Include the sessions before and after this one in the same worktree (default true)." },
        no_index: { type: "boolean" as const, description:
          "Do not import on a miss. Answers strictly from the index." },
      },
      required: ["id"],
    },
  },
  {
    name: "relic_chain",
    description:
      "Show a session's tree on a time axis: what ran sequentially, what ran in parallel. " +
      "Groups transcripts by workflow run and reports peak concurrency (an edge sweep over " +
      "start/end times) plus agent-time vs wall time — the ratio exceeds 1 only when work " +
      "genuinely overlapped. Use to understand the SHAPE of a session that spawned agents.",
    inputSchema: {
      type: "object",
      properties: {
        id: str("Session uuid or prefix."),
        limit: num("Max rows shown per group (default 8)."),
        width: num("Axis width in characters (default 40)."),
      },
      required: ["id"],
    },
  },
  {
    name: "relic_show",
    description:
      "Read the conversation around one event, straight from the source .jsonl. " +
      "The index stores a pointer, not an archive, so this is always current. " +
      "Take `file` and `seq` from a relic_search hit.",
    inputSchema: {
      type: "object",
      properties: {
        file: str("Absolute path to the transcript, as returned by relic_search."),
        seq: num("Event number within that file (the Nth non-empty line)."),
        before: num("Lines of context before (default 2)."),
        after: num("Lines of context after (default 2)."),
      },
      required: ["file", "seq"],
    },
  },
  {
    name: "relic_now",
    description:
      "What is running RIGHT NOW. With no arguments: identifies the CURRENT session for " +
      "the working directory and lists its live agents plus an activity timeline. " +
      "With all=true: every session written to recently across this machine, newest " +
      "first — the 'which agents are alive' question. " +
      "Answered from file mtime, NOT the index: a transcript being appended to right now " +
      "cannot be in an index that already ran, so this is the only tool here that is " +
      "current to the second. Use it to learn your own session id.",
    inputSchema: {
      type: "object",
      properties: {
        all: { type: "boolean" as const, description:
          "List every recently-active session on the machine instead of just this one." },
        cwd: str("Directory to resolve the session for (default: the server's cwd). " +
                 "Walks up to the nearest directory an agent was started in."),
        window: num("Seconds a write must be within to count as live (default 300)."),
        minutes: num("Span of the activity timeline (default 60)."),
        limit: num("Max rows (default 15)."),
      },
    },
  },
  {
    name: "relic_status",
    description:
      "What is indexed: one row per repo with session and event counts, biggest first. " +
      "Call this FIRST when you do not know which repo names are valid — the keys listed " +
      "here are exactly what the `repo` filter accepts.",
    inputSchema: {
      type: "object",
      properties: { limit: num("Max repo rows (default 25).") },
    },
  },
];

const fmt = (n: number) => n.toLocaleString("en-US");
const oneLine = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);

async function run(name: string, a: any): Promise<string> {
  const scope = scopeOf(a);

  if (name === "relic_now") {
    const windowSec = Number(a?.window ?? 300);

    if (a?.all) {
      const live = await liveSessions(windowSec, Number(a?.limit ?? 20));
      if (!live.length) return `nothing written in the last ${humanAge(windowSec)}`;
      const L = [`${live.length} session(s) active in the last ${humanAge(windowSec)}`, ""];
      for (const x of live) {
        L.push(`${humanAge(x.ageSec).padStart(5)} ago  ${x.sessionUuid}  ` +
               `${x.agents} live agent(s)  ${x.title ?? "(untitled)"}`);
        L.push(`            ${x.cwd ?? x.projectDir}`);
      }
      return L.join("\n");
    }

    const cur = await currentSession(a?.cwd ? String(a.cwd) : undefined);
    if (!cur) return `no session transcript for ${a?.cwd ?? "the current directory"}\n` +
                     `call again with all=true to see every active session`;

    const all = treeFiles(cur.projectDir, cur.sessionUuid);
    const agents = all.filter(x => x.tier !== "session" && x.ageSec <= windowSec);
    const L = [
      cur.title ?? "(untitled)",
      `${cur.sessionUuid} · last write ${humanAge(cur.ageSec)} ago`,
      cur.cwd,
    ];
    // The encoding maps both "/" and "." to "-", so two checkouts can share a project
    // directory. Report the doubt instead of presenting a guess as a fact.
    if (!cur.confident) L.push(`(!) this transcript's own cwd differs — it may belong to another checkout`);
    L.push(`${all.length} transcripts in the tree`, "");

    if (agents.length) {
      L.push(`live agents (written in the last ${humanAge(windowSec)}):`);
      for (const x of agents.slice(0, Number(a?.limit ?? 15)))
        L.push(`  ${humanAge(x.ageSec).padStart(5)} ago  ${x.tier.padEnd(14)} ${x.agentId ?? ""}` +
               (x.workflowRunId ? `  ${x.workflowRunId}` : ""));
      if (agents.length > 15) L.push(`  ... and ${agents.length - 15} more`);
    } else {
      L.push(`no agents running in the last ${humanAge(windowSec)}`);
    }

    const mins = Number(a?.minutes ?? 60);
    const b = activityBuckets(all, mins, 40);
    L.push("", `last ${mins}m |${sparkline(b.counts)}| ${b.counts.filter(c => c > 0).length}/40 buckets active`);
    return L.join("\n");
  }

  if (name === "relic_status") {
    const { root, rows } = await indexStatus(scope);
    if (!rows.length) return `no shards indexed under ${root}\nrun: relic index --since 7d`;
    const limit = Number(a?.limit ?? 25);
    const L = [`index ${root} · LanceDB + ICU full-text (BM25) · ${rows.length} repos`, ""];
    for (const r of rows.slice(0, limit))
      L.push(`${r.key.padEnd(46)} ${String(r.sessions).padStart(6)} sess ${fmt(r.events).padStart(11)} ev`);
    if (rows.length > limit) L.push(`... and ${rows.length - limit} more`);
    L.push("", `total ${fmt(rows.reduce((x, r) => x + r.events, 0))} events · ` +
               `${fmt(rows.reduce((x, r) => x + r.sessions, 0))} sessions`);
    return L.join("\n");
  }

  if (name === "relic_search") {
    const q = String(a.query ?? "");
    if (!q.trim()) return "relic_search needs a non-empty query";
    if (!pickShards(scope).length)
      return `no shards match${a?.repo ? ` repo~${a.repo}` : ""} — call relic_status to see what is indexed`;

    const limit = Number(a.limit ?? 20);
    const { hits, shards, ms, total } = await searchEvents(q, {
      ...scope, limit, role: a.role, prose: a.prose, tier: a.tier, source: a.source,
      worktree: a.worktree, path: a.path, since: a.since, until: a.until,
    });
    // Same trace log the CLI writes, so MCP traffic shows up in `relic trace` too —
    // otherwise the "which shards actually answer anything" question silently loses
    // every query a model made.
    trace({ ts: new Date().toISOString(), q, chars: [...q].length,
            filters: a?.repo ? { repo: String(a.repo) } : {},
            shards, hits: hits.length, ms, top_repo: hits[0]?.repo ?? "", fts: true }, DATA_ROOT);

    if (!hits.length) return `no matches for "${q}" across ${shards} shards (${ms} ms)`;
    const L = [`${Math.min(total, limit)} of ${total} matches · ${shards} shards · ${ms} ms`, ""];
    for (const h of hits.slice(0, limit)) {
      const i = h.text.toLowerCase().indexOf(q.toLowerCase());
      const snip = i < 0 ? h.text.slice(0, 200) : h.text.slice(Math.max(0, i - 70), i + q.length + 130);
      L.push(`${h.repo}${h.worktree ? ` [${h.worktree}]` : ""} · ${h.source}/${h.tier} · ${h.role} · ${h.ts}`);
      L.push(`  ...${oneLine(snip, 260)}...`);
      L.push(`  relic_show  file=${h.file_path}  seq=${h.seq}`);
      L.push("");
    }
    return L.join("\n");
  }

  if (name === "relic_sessions") {
    if (!pickShards(scope).length) return "no shards match — call relic_status";
    const { rows, total, events } = await listSessions({
      ...scope, since: a?.since, until: a?.until, worktree: a?.worktree, limit: Number(a?.limit ?? 40),
    });
    if (!total) return "no sessions match those filters";
    const L = [`${fmt(total)} sessions · ${fmt(events)} events`, ""];
    for (const r of rows) {
      L.push(`${localDateTime(r.started_at)}  ${r.session_uuid.slice(0, 8)}  ` +
             `${String(r.event_count).padStart(6)} ev  ${r.repo}${r.worktree ? ` [${r.worktree}]` : ""}`);
      L.push(`    ${oneLine(nameOf(r), 110)}`);
    }
    if (total > rows.length) L.push("", `... and ${total - rows.length} more (raise limit)`);
    return L.join("\n");
  }

  if (name === "relic_session") {
    const { rows, imported, matchedBy } = await resolveSession(String(a.id), { ...scope, noIndex: Boolean(a?.no_index) });
    if (!rows.length)
      return `nothing matches ${a.id} — tried it as an id, then as a name ` +
             `(a name is matched against the session title and opening message)` +
             (a?.no_index ? ". no_index was set, so disk was not searched." : "");

    // A name can legitimately match several sessions. Listing them is the answer —
    // picking one would be a guess, and the id is right there to disambiguate with.
    const uuids = new Set(rows.map(r => r.session_uuid));
    if (matchedBy === "name" && uuids.size > 1) {
      const L = [`${uuids.size} sessions named like "${a.id}" — call again with one id:`, ""];
      for (const r of rows)
        L.push(`${localDateTime(r.started_at)}  ${r.session_uuid}  ` +
               `${String(r.event_count).padStart(6)} ev  ${r.repo}  ${nameOf(r)}`);
      return L.join("\n");
    }

    const st = statsOf(rows)!;
    const parent = rows.find(r => r.tier === "session") ?? rows[0];
    const L = [
      nameOf(parent),
      `${parent.session_uuid} · matched by ${matchedBy}${imported ? ` · ${imported} imported on demand` : ""}`,
      `${st.repo}${st.worktree ? ` [${st.worktree}]` : ""}${st.model ? ` · ${st.model}` : ""}`,
      `${localDateTime(st.startedAt)} → ${localDateTime(st.endedAt)} · ` +
      `${fmt(st.transcripts)} transcripts · ${fmt(st.events)} events` +
      (st.runs ? ` · ${st.runs} workflow runs` : ""),
      `  ${st.tiers.map(t => `${t.tier} ${t.n}`).join(" · ")}`,
    ];

    if (a?.neighbours !== false) {
      const nb = await neighbours(parent, scope);
      if (nb.before.length || nb.after.length) {
        L.push("", "same worktree, either side:");
        const row = (r: typeof parent, m: string) =>
          L.push(`${m} ${localDateTime(r.started_at)}  ${r.session_uuid.slice(0, 8)}  ` +
                 `${String(r.event_count).padStart(6)} ev  ${oneLine(nameOf(r), 60)}`);
        for (const r of nb.before) row(r, "  ");
        row(parent, ">>");
        for (const r of nb.after) row(r, "  ");
      }
    }

    // Children sit under the parent's own directory, so their full paths repeat a long
    // identical prefix. Print it once.
    const limit = Number(a?.limit ?? 10);
    const base = parent.file_path.replace(/\.jsonl$/, "/");
    L.push("", `transcripts (under ${base}):`);
    for (const r of rows.slice(0, limit)) {
      const path = r.file_path === parent.file_path ? parent.file_path
                 : r.file_path.startsWith(base) ? r.file_path.slice(base.length) : r.file_path;
      L.push(`  ${localTime(r.started_at)}  ${r.tier.padEnd(14)} ${String(r.event_count).padStart(6)} ev  ${path}`);
    }
    if (rows.length > limit) L.push(`  ... and ${rows.length - limit} more (raise limit)`);
    if (rows.length > 1) L.push("", `relic_chain id=${parent.session_uuid.slice(0, 8)} — the same tree on a time axis`);
    return L.join("\n");
  }

  if (name === "relic_chain") {
    const { chain, imported } = await chainOf(String(a.id), scope);
    if (!chain) return `no session matches ${a.id}`;
    const head = imported ? `(${imported} transcripts imported on demand)\n\n` : "";
    return head + renderChain(chain, { width: Number(a?.width ?? 40), maxRows: Number(a?.limit ?? 8) });
  }

  if (name === "relic_show") {
    const lines = await readAround(String(a.file), Number(a.seq), Number(a?.before ?? 2), Number(a?.after ?? 2));
    if (!lines.length) return `no events around seq ${a.seq} in ${a.file}`;
    return lines.map(l => `${l.target ? ">>" : "  "} #${l.seq} ${l.role}: ${oneLine(l.text, 1200)}`).join("\n");
  }

  return `unknown tool ${name}`;
}

const server = new Server({ name: "relic", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return { content: [{ type: "text", text: await run(req.params.name, req.params.arguments ?? {}) }] };
  } catch (err) {
    // A thrown handler kills the tool call with no explanation on the model's side.
    // Return the message as content so the failure is legible and retryable.
    return { content: [{ type: "text", text: `relic error: ${String(err)}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
