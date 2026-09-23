import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore, type SessionRow } from "../src/store/lance.js";
import { toISO, listSessions } from "../src/query.js";

/**
 * Issue #59. `toISO` passed absolute times through untouched and the store compared them
 * as TEXT against UTC `started_at`, so `--since 2026-09-22T05:00` in Bangkok filtered as
 * 05:00 UTC — seven hours late — and `+07:00` was ignored outright. And a window matched
 * on start time alone, so a session running straight through an hour was absent from it.
 */

const TZ0 = process.env.TZ;
beforeAll(() => { process.env.TZ = "Asia/Bangkok"; });
afterAll(() => { process.env.TZ = TZ0; });

describe("toISO", () => {
  test("bare local, +07:00 and Z forms of one instant normalise to the same UTC string", () => {
    const want = "2026-09-21T22:00:00.000Z";
    expect(toISO("2026-09-22T05:00")).toBe(want);
    expect(toISO("2026-09-22T05:00:00+07:00")).toBe(want);
    expect(toISO("2026-09-21T22:00:00Z")).toBe(want);
  });

  test("a bare date keeps its meaning — UTC midnight, or end of day as an upper bound", () => {
    expect(toISO("2026-09-01")).toBe("2026-09-01T00:00:00Z");
    expect(toISO("2026-09-01", true)).toBe("2026-09-01T23:59:59Z");
  });

  test("a relative span is still measured back from now", () => {
    const got = Date.parse(toISO("7d")!);
    expect(Math.abs(got - (Date.now() - 7 * 86_400_000))).toBeLessThan(5_000);
  });

  test("something unparseable passes through rather than becoming a wrong date", () => {
    expect(toISO("not-a-date")).toBe("not-a-date");
    expect(toISO("")).toBeUndefined();
  });
});

describe("sessions window", () => {
  const tmp = mkdtempSync(join(tmpdir(), "relic-window-"));
  const shardDir = join(tmp, "banks", "projects", "github.com", "a", "b");
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  const row = (uuid: string, tier: string, started: string, ended: string, file = `/x/${uuid}-${tier}.jsonl`): SessionRow => ({
    session_uuid: uuid, file_path: file, repo_key: "github.com/a/b", project_dir: "p", tier, source: "claude",
    cwd: "", model: "", worktree: "", workflow_run_id: "", agent_id: "", file_mtime: 1, file_size: 2,
    line_count: 1, event_count: 5, bad_lines: 0, started_at: started, ended_at: ended, description: "d",
    imported_at: "", title: "", git_branch: "",
  });

  beforeAll(async () => {
    mkdirSync(shardDir, { recursive: true });
    const s = await LanceStore.open(shardDir);
    await s.putSessions([
      row("aaaa", "session", "2026-09-21T22:29:00.000Z", "2026-09-21T22:40:00.000Z"),    // 05:29–05:40 local
      row("bbbb", "session", "2026-09-21T22:30:00.000Z", "2026-09-22T06:15:00.000Z"),    // 05:30–13:15 local
      row("bbbb", "workflow_agent", "2026-09-22T05:05:00.000Z", "2026-09-22T05:30:00.000Z", "/x/bbbb/wf/agent-1.jsonl"),
      row("cccc", "session", "2026-09-21T20:00:00.000Z", "2026-09-21T21:00:00.000Z"),    // 03:00–04:00 local
    ]);
  });

  const ids = async (since: string, until: string) =>
    (await listSessions({ dataRoot: tmp, since, until })).rows.map(r => r.session_uuid).sort();

  test("all three forms of one window return the same rows", async () => {
    const bare = await ids("2026-09-22T05:00", "2026-09-22T06:00");
    expect(bare).toEqual(["aaaa", "bbbb"]);
    expect(await ids("2026-09-22T05:00:00+07:00", "2026-09-22T06:00:00+07:00")).toEqual(bare);
    expect(await ids("2026-09-21T22:00:00Z", "2026-09-21T23:00:00Z")).toEqual(bare);
  });

  test("the displayed start is the tree's own, inside the window it matched", async () => {
    const r = (await listSessions({ dataRoot: tmp, since: "2026-09-22T05:00", until: "2026-09-22T06:00" }))
      .rows.find(x => x.session_uuid === "bbbb")!;
    expect(r.started_at).toBe("2026-09-21T22:30:00.000Z");
  });

  test("a session running straight through the hour is in that hour", async () => {
    expect(await ids("2026-09-22T07:00", "2026-09-22T08:00")).toEqual(["bbbb"]);
  });
});
