import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChannelEnvelope, viaLabel, saidText } from "../src/types.js";
import { parseClaude } from "../src/shapes/claude.js";
import { importFiles, roomsOf } from "../src/import.js";
import { LanceStore } from "../src/store/lance.js";
import { searchEvents, roomTag, chatLabel, channelHead, listSessions } from "../src/query.js";
import { sessionRecap } from "../src/recap.js";
import { planChannelBackfill, applyChannelBackfill } from "../src/backfill.js";
import { shardDirFor } from "../src/repo.js";
import type { Found } from "../src/discover.js";

/*
 * #85 / #86 — a channel envelope is the only place a turn records who sent it, from
 * which room, and on whose clock. These pin: the parse (one fixture, read by the Python
 * suite too), the import that writes it as columns beside the raw text, the filters
 * over those columns — including on a shard written before they existed — the renders,
 * and the backfill that brings old rows up to date.
 */
const FIX = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "channel-envelopes.json"), "utf8"));

describe("parseChannelEnvelope — the pairs relicpy must agree on", () => {
  for (const c of FIX.parse as { name: string; text: string; want: unknown }[])
    test(c.name, () => { expect(parseChannelEnvelope(c.text)).toEqual(c.want as any); });

  for (const [via, label] of FIX.via_label as [string, string][])
    test(`viaLabel ${via}`, () => { expect(viaLabel(via)).toBe(label); });

  for (const c of FIX.rooms as { name: string; channels: unknown[]; want: unknown }[])
    test(`roomsOf: ${c.name}`, () => { expect(roomsOf(c.channels.map(channel => ({ channel }) as any))).toEqual(c.want as any); });
});

describe("rendering stays short and outside the name", () => {
  const c = parseChannelEnvelope(FIX.parse[0].text)!;
  test("a turn reads as its sender and its words", () => {
    expect(saidText(FIX.parse[0].text)).toBe("nazt_ (discord): yo");
    expect(saidText("plain words")).toBe("plain words");
  });
  test("a snowflake is shortened to its tail, a short id is whole", () => {
    expect(chatLabel("1512079809021214730")).toBe("#…214730");
    expect(chatLabel("nh-test")).toBe("#nh-test");
  });
  test("a hit says who, where and when", () => {
    expect(channelHead(c)).toMatch(/^nazt_ @ discord #…214730 · sent 2026-08-2\d \d\d:\d\d UTC[+-]\d\d/);
    const inbox = FIX.parse.find((x: { name: string }) => x.name.startsWith("an inbox snapshot")).text;
    expect(channelHead(parseChannelEnvelope(inbox)!)).toBe("arra-inbox-v3");
  });
  test("a session tag names the main room, how many more, and who", () => {
    expect(roomTag({ via: "plugin:discord:discord", chat_id: "1512079809021214730,1500682214571118624", from_users: "nazt_,ting_41427" }))
      .toBe("[discord #…214730 +1 · nazt_, ting_41427]");
    expect(roomTag({ via: "", chat_id: "", from_users: "" })).toBe("");
    expect(roomTag({})).toBe("");      // a row from before the columns existed
  });
});

// ---- a real transcript, imported ----------------------------------------------------

const tmp = mkdtempSync(join(tmpdir(), "relic-channel-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const CWD = "/opt/Code/github.com/acme/widget";
const REPO = "github.com/acme/widget";
const BANK = "projects";
const env = (chat: string, msg: string, user: string, uid: string, ts: string, body: string) =>
  `<channel source="plugin:discord:discord" chat_id="${chat}" message_id="${msg}" user="${user}" user_id="${uid}" ts="${ts}">\n${body}\n</channel>`;
const A = "1512079809021214730", B = "1500682214571118624";
const TURNS: [string, string, string][] = [
  // [role, transcript ts, text]
  ["user", "2026-09-23T01:01:00.000Z", env(A, "m1", "nazt_", "691531480689541170", "2026-09-23T01:00:59.800Z", "please fix the relay")],
  ["assistant", "2026-09-23T01:02:00.000Z", "on it"],
  // Queued: sent two hours before the transcript saw it.
  ["user", "2026-09-23T03:03:00.000Z", env(B, "m2", "ting_41427", "7", "2026-09-23T01:03:00.000Z", "ดูให้หน่อย relay")],
  ["assistant", "2026-09-23T03:04:00.000Z", "done"],
  ["user", "2026-09-23T03:05:00.000Z", env(A, "m3", "nazt_", "691531480689541170", "2026-09-23T03:04:59.900Z", "ship it")],
  // Quoting an envelope is not a delivery.
  ["user", "2026-09-23T03:06:00.000Z", `why did <channel source="plugin:discord:discord" user="bob">x</channel> show up in the relay log`],
];

function writeTranscript(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, TURNS.map(([role, ts, text]) => JSON.stringify({
    type: role, sessionId: "c0ffee00-0000-4000-8000-000000000001", cwd: CWD, timestamp: ts,
    message: { role, content: role === "user" ? text : [{ type: "text", text }] },
  })).join("\n") + "\n");
}

const foundOf = (path: string): Found => {
  const st = statSync(path);
  return { path, projectDir: "-opt-Code-github-com-acme-widget", tier: "session", source: "claude", bank: BANK,
           workflowRunId: null, agentId: null, mtime: Math.floor(st.mtimeMs / 1000), size: st.size, parser: parseClaude };
};

// Top-level setup, as generic-query.test.ts does: describe() callbacks run synchronously.
const FRESH = { root: join(tmp, "fresh"), file: join(tmp, "src", "c0ffee00-0000-4000-8000-000000000001.jsonl") };
writeTranscript(FRESH.file);
const freshTally = await importFiles([foundOf(FRESH.file)], { dataRoot: FRESH.root, inRepo: false });

describe("import: facets beside the raw text, never in place of it", () => {
  const { root, file } = FRESH;
  const tally = freshTally;
  const rows = async () => {
    const store = await LanceStore.open(shardDirFor(REPO, root, false, BANK));
    return { store, events: (await store.eventsWhere("seq > 0")).sort((a, b) => Number(a.seq) - Number(b.seq)) };
  };

  test("the file imported", () => {
    expect(tally.failed).toBe(0);
    expect(tally.imported).toBe(1);
  });
  test("a delivery carries its facets, and its text is the raw envelope", async () => {
    const e = (await rows()).events[0];
    expect(e.text).toBe(TURNS[0][2]);
    expect({ via: e.via, chat_id: e.chat_id, msg_id: e.msg_id, from_user: e.from_user,
             from_user_id: e.from_user_id, sent_ts: e.sent_ts, ts: e.ts })
      .toEqual({ via: "plugin:discord:discord", chat_id: A, msg_id: "m1", from_user: "nazt_",
                 from_user_id: "691531480689541170", sent_ts: "2026-09-23T01:00:59.800Z", ts: "2026-09-23T01:01:00.000Z" });
  });
  test("assistant turns and a quoted envelope carry none", async () => {
    const { events } = await rows();
    expect(events.filter(e => e.via).map(e => Number(e.seq))).toEqual([1, 3, 5]);
    expect(events[5].via).toBe("");
    expect(events[5].from_user).toBe("");
  });
  test("the session row lists its rooms and senders, most frequent first", async () => {
    const [s] = await (await rows()).store.sessionsOf([file]);
    expect({ via: s.via, chat_id: s.chat_id, from_users: s.from_users })
      .toEqual({ via: "plugin:discord:discord", chat_id: `${A},${B}`, from_users: "nazt_,ting_41427" });
    expect(s.description).toBe("please fix the relay");
    const listed = (await listSessions({ dataRoot: root })).rows;
    expect(roomTag(listed[0])).toBe("[discord #…214730 +1 · nazt_, ting_41427]");
  });

  test("search filters by the front door, the room and the sender — substrings, case-blind", async () => {
    const hits = async (o: object) => (await searchEvents("relay", { dataRoot: root, warnGeneric: false, ...o })).hits.map(h => Number(h.seq));
    expect((await hits({ via: "discord" })).sort()).toEqual([1, 3]);
    expect(await hits({ fromUser: "NAZT" })).toEqual([1]);
    expect(await hits({ chat: B.slice(-6) })).toEqual([3]);
    expect(await hits({ via: "telegram" })).toEqual([]);
    // No facet filter: the quoting turn is still an ordinary hit.
    expect((await hits({})).sort()).toEqual([1, 3, 6]);
    expect((await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false })).unfaceted).toBe(0);
  });

  test("recap lists a channel turn as its sender and words", async () => {
    const r = await sessionRecap("c0ffee00", { dataRoot: root });
    expect(r!.asked[0].text).toBe("nazt_ (discord): please fix the relay");
  });

  test("tail --handoff: the sender prefix sits outside the --chars budget", async () => {
    const out = await cli(["tail", file, "--handoff", "--chars", "10"]);
    expect(out).toContain("\n  nazt_ (discord): please fix …\n");
    expect(out).not.toContain("<channel");
  });

  test("plain tail heads a turn with its sender, and with THEIR clock only when it disagrees", async () => {
    const out = await cli(["tail", file, "--flat", "-n", "6"]);
    expect(out).toMatch(/#\s+1 user {2}\S+ \S+ {2}· {2}nazt_ \(discord\)\n {2}please fix the relay/);
    expect(out).toMatch(/#\s+3 user {2}\S+ \S+ {2}· {2}ting_41427 \(discord\), sent \S+ \S+\n/);
    expect(out).not.toContain("<channel source=\"plugin:discord:discord\" chat_id");
  });
});

async function cli(args: string[]): Promise<string> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// ---- a shard written before the columns existed -----------------------------------

/**
 * Rows exactly as the importer wrote them before this change: no facet columns, and a
 * session description that still opens with the envelope (pre-#92). The manifest
 * matches the file on disk, so a plain index run skips it as unchanged — which is the
 * whole reason a backfill exists.
 */
async function oldShard(root: string, file: string) {
  const p = await parseClaude(file);
  const st = statSync(file);
  const store = await LanceStore.open(shardDirFor(REPO, root, false, BANK));
  await store.putEvents(p.events.map(e => ({
    uid: e.uid, session_uuid: p.sessionUuid, file_path: file, repo_key: REPO, seq: e.seq, role: e.role,
    ts: e.ts ?? "", text: e.text, source: "claude", tier: "session", kind: "transcript", worktree: "",
    cwd: CWD, org: "acme", project: "", dir: "", mem_type: "", origin_session: "",
  })) as any);
  await store.putSessions([{
    session_uuid: p.sessionUuid, file_path: file, repo_key: REPO, project_dir: "-opt-Code-github-com-acme-widget",
    tier: "session", source: "claude", cwd: CWD, model: "", worktree: "", workflow_run_id: "", agent_id: "",
    file_mtime: Math.floor(st.mtimeMs / 1000), file_size: st.size, line_count: p.lines, event_count: p.events.length,
    bad_lines: 0, started_at: p.startedAt ?? "", ended_at: p.endedAt ?? "",
    description: TURNS[0][2].slice(0, 200), imported_at: "2026-09-01T00:00:00.000Z", title: "", git_branch: "",
  }] as any);
  await store.putFiles([{ file_path: file, repo_key: REPO, mtime: Math.floor(st.mtimeMs / 1000), size: st.size,
                          imported_at: "2026-09-01T00:00:00.000Z" }]);
  await store.ensureFtsIndex();
  return store;
}

const OLD = { root: join(tmp, "old"), file: join(tmp, "src-old", "c0ffee00-0000-4000-8000-000000000001.jsonl") };
writeTranscript(OLD.file);
const oldStore = await oldShard(OLD.root, OLD.file);

describe("a shard indexed before the facets existed", () => {
  const { root } = OLD;
  const store = oldStore;

  test("a facet filter on it is an empty answer, not an error", async () => {
    expect(await store.missingColumns("events", ["via"])).toEqual(["via"]);
    expect(await store.search("relay", { via: "discord" })).toEqual([]);
    expect(await store.search("relay", { fromUser: "nazt", chat: "214730" })).toEqual([]);
  });
  test("searchEvents counts it as unfaceted, and unfiltered search still answers from it", async () => {
    const r = await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false });
    expect(r.hits).toEqual([]);
    expect(r.unfaceted).toBe(1);
    expect((await searchEvents("relay", { dataRoot: root, warnGeneric: false })).hits.length).toBe(3);
  });
  test("its sessions list without a tag, and without failing", async () => {
    const { rows } = await listSessions({ dataRoot: root });
    expect(rows.length).toBe(1);
    expect(roomTag(rows[0])).toBe("");
  });
});

const BF = { root: join(tmp, "backfill"), file: join(tmp, "src-bf", "c0ffee00-0000-4000-8000-000000000001.jsonl") };
writeTranscript(BF.file);
const bfStore = await oldShard(BF.root, BF.file);
const bfBefore = (await bfStore.eventsWhere("seq > 0")).length;

describe("index --backfill-channel", () => {
  const { root, file } = BF;
  const store = bfStore, before = bfBefore;

  test("a plain index run skips the file as unchanged — the gap a backfill closes", async () => {
    const t = await importFiles([foundOf(file)], { dataRoot: root, inRepo: false });
    expect(t.skipped).toBe(1);
    expect(t.imported).toBe(0);
  });

  test("the plan names the file once, for both reasons, and writes nothing", async () => {
    const plan = await planChannelBackfill({ dataRoot: root });
    expect(plan.files.map(f => [f.found.path, f.why, f.turns])).toEqual([[file, ["facets", "names"], 3]]);
    expect(plan.files[0].found).toMatchObject({ bank: BANK, tier: "session", source: "claude" });
    expect(plan.bytes).toBe(statSync(file).size);
    expect(await store.missingColumns("events", ["via"])).toEqual(["via"]);
  });

  test("--apply re-imports it in place: facets filled, name rewritten, nothing doubled", async () => {
    const t = await applyChannelBackfill(await planChannelBackfill({ dataRoot: root }), { dataRoot: root, inRepo: false });
    expect(t.failed).toBe(0);
    expect(t.imported).toBe(1);
    const fresh = await LanceStore.open(shardDirFor(REPO, root, false, BANK));
    const events = await fresh.eventsWhere("seq > 0");
    expect(events.length).toBe(before);
    expect(events.filter(e => e.via).length).toBe(3);
    const [s] = await fresh.sessionsOf([file]);
    expect(s.description).toBe("please fix the relay");
    expect(s.from_users).toBe("nazt_,ting_41427");
    expect((await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false })).hits.length).toBe(2);
  });

  test("and the next plan is empty", async () => {
    expect((await planChannelBackfill({ dataRoot: root })).files).toEqual([]);
  });
});
