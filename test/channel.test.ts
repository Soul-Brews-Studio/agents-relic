import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseChannelEnvelope, viaLabel, saidText } from "../src/types.js";
import { parseClaude } from "../src/shapes/claude.js";
import { importFiles, roomsOf } from "../src/import.js";
import { LanceStore } from "../src/store/lance.js";
import { searchEvents, roomTag, chatLabel, channelHead, listSessions, facetArg } from "../src/query.js";
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

/** A fresh old shard of its own, so no test depends on another's writes. */
let shardN = 0;
async function freshOld() {
  const root = join(tmp, `old-${++shardN}`), file = join(tmp, `src-old-${shardN}`, "c0ffee00-0000-4000-8000-000000000001.jsonl");
  writeTranscript(file);
  return { root, file, store: await oldShard(root, file) };
}
const reopen = (root: string) => LanceStore.open(shardDirFor(REPO, root, false, BANK));
/** uid -> the row's text: what "nothing lost, nothing rewritten" is measured against. */
const texts = async (root: string) =>
  new Map((await (await reopen(root)).eventsWhere("seq > 0")).map(e => [String(e.uid), String(e.text)]));

const OLD = await freshOld();

describe("a shard indexed before the facets existed", () => {
  const { root, store } = OLD;

  test("a facet filter on it is an empty answer, not an error", async () => {
    expect(await store.missingColumns("events", ["via"])).toEqual(["via"]);
    expect(await store.search("relay", { via: "discord" })).toEqual([]);
    expect(await store.search("relay", { fromUser: "nazt", chat: "214730" })).toEqual([]);
  });
  test("searchEvents counts its channel turns as unfaceted, and unfiltered search still answers", async () => {
    const r = await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false });
    expect(r.hits).toEqual([]);
    expect([r.unfaceted, r.unfacetedTurns]).toEqual([1, 3]);
    expect((await searchEvents("relay", { dataRoot: root, warnGeneric: false })).hits.length).toBe(3);
  });
  test("its sessions list without a tag, and without failing", async () => {
    const { rows } = await listSessions({ dataRoot: root });
    expect(rows.length).toBe(1);
    expect(roomTag(rows[0])).toBe("");
  });
});

describe("an old shard that an ordinary index run has since widened", () => {
  test("still reports its unfilled turns — the schema says faceted, the rows do not", async () => {
    const { root, file } = await freshOld();
    // One NEW channel session lands in the same shard through a normal import: widen() adds
    // the columns, and every old row now holds via = "".
    const other = join(tmp, "src-new", "dddddddd-0000-4000-8000-000000000004.jsonl");
    mkdirSync(join(other, ".."), { recursive: true });
    writeFileSync(other, JSON.stringify({ type: "user", sessionId: "dddddddd-0000-4000-8000-000000000004", cwd: CWD,
      timestamp: "2026-09-23T05:00:00.000Z",
      message: { role: "user", content: env(A, "n1", "nazt_", "1", "2026-09-23T05:00:00.000Z", "is the relay fixed") } }) + "\n");
    const t = await importFiles([foundOf(file), foundOf(other)], { dataRoot: root, inRepo: false });
    expect([t.imported, t.skipped]).toEqual([1, 1]);
    expect(await (await reopen(root)).missingColumns("events", ["via"])).toEqual([]);

    const r = await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false });
    expect(r.hits.map(h => String(h.file_path))).toEqual([other]);
    expect([r.unfaceted, r.unfacetedTurns]).toEqual([1, 3]);

    await applyChannelBackfill(await planChannelBackfill({ dataRoot: root }));
    const after = await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false });
    expect(after.hits.length).toBe(3);
    expect([after.unfaceted, after.unfacetedTurns]).toEqual([0, 0]);
  });
});

describe("facet filters match what was typed, literally", () => {
  test("`_` and `%` are characters, not wildcards", async () => {
    const dir = join(tmp, "literal", "banks", BANK, "github.com", "acme", "literal");
    const store = await LanceStore.open(dir);
    const row = (uid: string, from_user: string) => ({
      uid, session_uuid: "s", file_path: "/f.jsonl", repo_key: REPO, seq: 1, role: "user", ts: "2026-09-23T00:00:00Z",
      text: "relay down again", source: "claude", tier: "session", kind: "transcript", worktree: "", cwd: "", org: "",
      project: "", dir: "", mem_type: "", origin_session: "", via: "plugin:discord:discord", chat_id: "1", msg_id: uid,
      from_user, from_user_id: "", sent_ts: "" });
    await store.putEvents([row("u1", "nazt_"), row("u2", "naztX"), row("u3", "100%")] as any);
    const who = async (fromUser: string) =>
      (await store.search("relay", { fromUser, mainTiers: true })).map(h => String(h.from_user)).sort();
    expect(await who("nazt_")).toEqual(["nazt_"]);
    expect(await who("%")).toEqual(["100%"]);
    expect(await who("_")).toEqual(["nazt_"]);
    expect(await who("NAZT")).toEqual(["naztX", "nazt_"]);   // code-unit order: X before _
  });

  test("a value that is not a string is converted or refused at the edge", () => {
    expect(facetArg("chat", 214730)).toBe("214730");            // an MCP client sending a number
    expect(facetArg("--via", undefined)).toBeUndefined();
    expect(() => facetArg("--via", true)).toThrow("--via needs a value");   // a bare flag
    expect(() => facetArg("from_user", "   ")).toThrow("non-empty");
  });

  test("the CLI refuses a bare facet flag, and facets with --semantic", async () => {
    const bare = await cliFull(["search", "relay", "--data-root", OLD.root, "--via"]);
    expect([bare.code, bare.err]).toEqual([1, "--via needs a value, e.g. --via discord\n"]);
    const sem = await cliFull(["search", "relay", "--data-root", OLD.root, "--semantic", "--via", "discord"]);
    expect(sem.code).toBe(1);
    expect(sem.err).toContain("--semantic would ignore them");
  });
});

describe("the model's renders keep every id whole", () => {
  test("a search hit head names the full chat_id and message_id", () => {
    const c = parseChannelEnvelope(FIX.parse[0].text)!;
    expect(channelHead(c, { full: true })).toBe(
      "nazt_ (user_id 691531480689541170) · via plugin:discord:discord · chat_id 1512079809021214730 · " +
      "message_id 1540006806481535127 · sent 2026-08-20T14:37:14.608Z");
  });
  test("a session tag lists the rooms whole", () => {
    expect(roomTag({ via: "plugin:discord:discord", chat_id: `${A},${B}`, from_users: "nazt_" }, { full: true }))
      .toBe(`[plugin:discord:discord chat_id ${A}, ${B} · nazt_]`);
  });
});

async function cliFull(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(proc.stdout).text(), await new Response(proc.stderr).text()];
  return { code: await proc.exited, out, err };
}

describe("index --backfill-channel: in place, from the stored text", () => {
  test("a plain index run skips the old file as unchanged — the gap a backfill closes", async () => {
    const { root, file } = await freshOld();
    const t = await importFiles([foundOf(file)], { dataRoot: root, inRepo: false });
    expect([t.skipped, t.imported]).toEqual([1, 0]);
  });

  test("the plan counts turns, rooms and names, and writes nothing", async () => {
    const { root, store } = await freshOld();
    const plan = await planChannelBackfill({ dataRoot: root });
    expect([plan.turns, plan.rooms, plan.names.pending, plan.names.planned]).toEqual([3, 1, 1, 0]);
    expect(plan.shards.map(x => x.files)).toEqual([1]);
    expect(await store.missingColumns("events", ["via"])).toEqual(["via"]);
  });

  test("--apply fills the facets and rooms, and adds, removes or rewrites no row", async () => {
    const { root, file } = await freshOld();
    const before = await texts(root);
    const wrote = await applyChannelBackfill(await planChannelBackfill({ dataRoot: root }));
    expect(wrote).toEqual({ events: 3, sessions: 1 });
    expect(await texts(root)).toEqual(before);             // same uids, same text, byte for byte
    const store = await reopen(root);
    const rows = (await store.eventsWhere("seq > 0")).sort((a, b) => Number(a.seq) - Number(b.seq));
    expect(rows.map(e => String(e.from_user))).toEqual(["nazt_", "", "ting_41427", "", "nazt_", ""]);
    expect(String(rows[2].sent_ts)).toBe("2026-09-23T01:03:00.000Z");
    const [s] = await store.sessionsOf([file]);
    expect([s.via, s.chat_id, s.from_users]).toEqual(["plugin:discord:discord", `${A},${B}`, "nazt_,ting_41427"]);
    expect(String(s.description).startsWith("<channel")).toBe(true);   // names only with --names
    expect((await searchEvents("relay", { dataRoot: root, via: "discord", warnGeneric: false })).hits.length).toBe(2);
    const next = await planChannelBackfill({ dataRoot: root });
    expect([next.turns, next.rooms, next.shards.length]).toEqual([0, 0, 0]);
  });

  test("--names rewrites the session row from the transcript, and touches no event", async () => {
    const { root, file } = await freshOld();
    await applyChannelBackfill(await planChannelBackfill({ dataRoot: root }));
    const events = await (await reopen(root)).eventsWhere("seq > 0");
    const plan = await planChannelBackfill({ dataRoot: root }, { names: true });
    expect([plan.turns, plan.names.planned, plan.shards[0].events.length]).toEqual([0, 1, 0]);
    await applyChannelBackfill(plan);
    const store = await reopen(root);
    expect(await store.eventsWhere("seq > 0")).toEqual(events);
    const [s] = await store.sessionsOf([file]);
    expect([s.description, s.from_users]).toEqual(["please fix the relay", "nazt_,ting_41427"]);
    expect((await planChannelBackfill({ dataRoot: root }, { names: true })).names.pending).toBe(0);
  });

  test("the dry run's next command carries every flag it was given", async () => {
    const { root } = await freshOld();
    const r = await cliFull(["index", "--backfill-channel", "--data-root", root, "--bank", BANK, "--repo", "widget"]);
    expect(r.out).toContain(`to write them:  relic index --backfill-channel --apply --data-root ${root} --bank ${BANK} --repo widget\n`);
    expect(r.out).toContain("facets:      3 channel turns");
  });
});

/**
 * THE KILL TEST. The first backfill deleted a file's rows in one commit and wrote them back
 * in the next; a process killed in between lost them for good. Here every write is an
 * update of rows that exist, so a kill at either commit boundary must lose nothing.
 */
describe("a backfill killed mid-apply loses nothing", () => {
  const proto = LanceStore.prototype as any;
  const killAt = async (table: string, run: () => Promise<unknown>) => {
    const real = proto.updateRows;
    proto.updateRows = async function (name: string, ...rest: unknown[]) {
      if (name === table) throw new Error(`simulated kill before the ${table} commit`);
      return real.call(this, name, ...rest);
    };
    try { await run(); } catch { /* the kill */ } finally { proto.updateRows = real; }
  };

  test("killed after the event commit: rows intact, rooms finished by the next run", async () => {
    const { root, file } = await freshOld();
    const before = await texts(root);
    await killAt("sessions", async () => applyChannelBackfill(await planChannelBackfill({ dataRoot: root })));
    expect(await texts(root)).toEqual(before);
    const mid = await reopen(root);
    expect((await mid.eventsWhere("seq > 0")).filter(e => e.via).length).toBe(3);
    expect(String((await mid.sessionsOf([file]))[0].from_users ?? "")).toBe("");
    // A plain index run neither repairs nor harms it; the next backfill plan is exactly what is left.
    expect((await importFiles([foundOf(file)], { dataRoot: root, inRepo: false })).skipped).toBe(1);
    const next = await planChannelBackfill({ dataRoot: root });
    expect([next.turns, next.rooms]).toEqual([0, 1]);
    await applyChannelBackfill(next);
    expect(String((await (await reopen(root)).sessionsOf([file]))[0].from_users)).toBe("nazt_,ting_41427");
    expect(await texts(root)).toEqual(before);
  });

  test("killed before any commit: nothing changed, and the plan is the same", async () => {
    const { root } = await freshOld();
    const before = await texts(root);
    await killAt("events", async () => applyChannelBackfill(await planChannelBackfill({ dataRoot: root })));
    expect(await texts(root)).toEqual(before);
    const next = await planChannelBackfill({ dataRoot: root });
    expect([next.turns, next.rooms]).toEqual([3, 1]);
  });
});
