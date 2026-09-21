import { expect, test, describe } from "bun:test";
import { buildReport, renderReport, localDay, type ReportRow } from "../src/report.js";

const row = (o: Partial<ReportRow>): ReportRow => ({
  session_uuid: "s", file_path: "/f", repo_key: "r", project_dir: "p",
  tier: "session", source: "claude", cwd: "", model: "", worktree: "",
  workflow_run_id: "", agent_id: "", file_mtime: 0, file_size: 0,
  line_count: 0, event_count: 0, bad_lines: 0, started_at: "", ended_at: "",
  description: "", title: "", git_branch: "", imported_at: "",
  repo: "projects/github.com/org/repo", ...o,
} as ReportRow);

const nameOf = (r: any) => String(r.title ?? "");

describe("localDay is LOCAL, not UTC", () => {
  test("an instant built from local midnight-ish stays on its own local day", () => {
    /*
     * `iso.slice(0, 10)` is the obvious implementation and it is wrong: at UTC+07 a
     * session at 01:30 local belongs to the PREVIOUS UTC day, so the report files it
     * one row too early — on the only axis the report exists to show.
     *
     * Constructed from local components so the assertion holds in any timezone,
     * rather than hard-coding a Bangkok offset the CI box would not share.
     */
    const local = new Date(2026, 8, 20, 1, 30, 0);     // 20 Sep 01:30 LOCAL
    expect(localDay(local.toISOString())).toBe("2026-09-20");
  });
  test("a bad timestamp yields '' rather than Invalid Date", () => {
    expect(localDay("not-a-date")).toBe("");
    expect(localDay("")).toBe("");
  });
});

describe("buildReport", () => {
  const iso = (h: number) => new Date(2026, 8, 20, h, 0, 0).toISOString();

  test("a session tree collapses to ONE row carrying every child's events", () => {
    const days = buildReport([
      row({ session_uuid: "a", file_path: "/p/a.jsonl", tier: "session", event_count: 10, started_at: iso(9), title: "parent" }),
      row({ session_uuid: "a", file_path: "/p/a/subagents/x.jsonl", tier: "subagent", event_count: 5, started_at: iso(9) }),
      row({ session_uuid: "a", file_path: "/p/a/subagents/y.jsonl", tier: "subagent", event_count: 7, started_at: iso(9) }),
    ], nameOf);
    expect(days).toHaveLength(1);
    expect(days[0].sessions).toHaveLength(1);
    expect(days[0].sessions[0].events).toBe(22);        // the TREE, not the parent
    expect(days[0].sessions[0].transcripts).toBe(3);
    expect(days[0].sessions[0].name).toBe("parent");    // the `session` tier row wins
  });

  test("the same uuid in two REPOS stays two sessions", () => {
    // uuid is not a key across shards — the three Claude roots overlap by 742 sessions.
    const days = buildReport([
      row({ session_uuid: "a", started_at: iso(9), repo: "projects/github.com/org/one" }),
      row({ session_uuid: "a", started_at: iso(9), repo: "projects/github.com/org/two" }),
    ], nameOf);
    expect(days[0].sessions).toHaveLength(2);
  });

  test("days come back newest first, sessions within a day oldest first", () => {
    const d1 = new Date(2026, 8, 19, 10).toISOString();
    const d2a = new Date(2026, 8, 20, 8).toISOString();
    const d2b = new Date(2026, 8, 20, 14).toISOString();
    const days = buildReport([
      row({ session_uuid: "x", started_at: d2b }),
      row({ session_uuid: "y", started_at: d1 }),
      row({ session_uuid: "z", started_at: d2a }),
    ], nameOf);
    expect(days.map(d => d.day)).toEqual(["2026-09-20", "2026-09-19"]);
    expect(days[0].sessions.map(s => s.id)).toEqual(["z", "x"]);   // chronological
  });

  test("a row with no timestamp is dropped, not filed under a phantom day", () => {
    const days = buildReport([row({ session_uuid: "n", started_at: "" })], nameOf);
    expect(days).toEqual([]);
  });
});

describe("renderReport caps PER REPO, not per day", () => {
  /*
   * Per-day was the first shape and it hid the answer: one repo with 28 sessions ate
   * the whole budget, so every other repo touched that day rendered as "... and 60
   * more". The question a report answers is WHICH repos a day belonged to.
   */
  const iso = (h: number) => new Date(2026, 8, 20, h, 0, 0).toISOString();
  const busy = Array.from({ length: 20 }, (_, i) =>
    row({ session_uuid: `b${i}`, started_at: iso(1 + i % 20), repo: "projects/github.com/org/busy" }));
  const quiet = [row({ session_uuid: "q", started_at: iso(9), repo: "projects/github.com/org/quiet" })];

  test("the quiet repo still appears when the busy one overflows", () => {
    const lines = renderReport(buildReport([...busy, ...quiet], nameOf), { perRepo: 2 });
    const text = lines.join("\n");
    expect(text).toContain("org/busy");
    expect(text).toContain("org/quiet");
    expect(text).toContain("and 18 more in this repo");
  });

  test("no overflow line when the repo fits", () => {
    const lines = renderReport(buildReport(quiet, nameOf), { perRepo: 2 });
    expect(lines.join("\n")).not.toContain("more in this repo");
  });
});
