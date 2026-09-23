import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastEventMs, rankByLastEvent, clockLabel } from "../src/live.js";

/**
 * mtime is not liveness (#67): Claude Code rewrites untimestamped records (permission-mode,
 * file-history-snapshot, last-prompt, cost-state) in place, so a transcript idle for 42h can
 * hold the newest mtime in its directory. Measured on m5: 402 of 759 transcripts had mtime
 * more than 1h past their last event.
 */

const H = 3_600_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const ev = (ms: number, text = "x") =>
  JSON.stringify({ type: "user", timestamp: iso(ms), message: { role: "user", content: text } });
const meta = (type: string) => JSON.stringify({ type, sessionId: "s", pad: "m".repeat(200) });

let dir: string;
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "relic-liveness-")); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, lines: string[], mtimeMs: number): string {
  const p = join(dir, name);
  writeFileSync(p, lines.join("\n") + "\n");
  utimesSync(p, new Date(mtimeMs), new Date(mtimeMs));
  return p;
}

describe("lastEventMs", () => {
  test("reads the newest timestamped record, skipping untimestamped metadata at the tail", () => {
    const p = write("a.jsonl", [ev(NOW - 42 * H), ev(NOW - 41 * H), meta("permission-mode"), meta("cost-state")], NOW);
    expect(lastEventMs(p)).toBe(NOW - 41 * H);
  });

  test("widens the window when the last lines hold no timestamp", () => {
    const p = write("wide.jsonl", [ev(NOW - 2 * H), JSON.stringify({ type: "cost-state", pad: "c".repeat(200_000) })], NOW);
    expect(lastEventMs(p)).toBe(NOW - 2 * H);
  });

  test("a transcript with no timestamp at all has no event clock", () => {
    const p = write("none.jsonl", [meta("mode"), meta("file-history-snapshot")], NOW);
    expect(lastEventMs(p)).toBeNull();
  });
});

describe("rankByLastEvent", () => {
  test("a metadata-only rewrite does not promote an idle session", () => {
    const idle = write("idle.jsonl", [ev(NOW - 42 * H), meta("permission-mode")], NOW - 30 * 60_000);
    const working = write("working.jsonl", [ev(NOW - 50 * 60_000)], NOW - 50 * 60_000);
    const cands = [{ path: idle, mtimeMs: NOW - 30 * 60_000 }, { path: working, mtimeMs: NOW - 50 * 60_000 }];
    const ranked = rankByLastEvent(cands, 1);
    expect(ranked[0].path).toBe(working);
  });

  test("stops reading once no older-mtime file could win", () => {
    const fresh = write("fresh.jsonl", [ev(NOW - 60_000)], NOW - 60_000);
    const old = write("old.jsonl", [ev(NOW - 10 * H)], NOW - 10 * H);
    const ranked = rankByLastEvent([{ path: old, mtimeMs: NOW - 10 * H }, { path: fresh, mtimeMs: NOW - 60_000 }], 1);
    expect(ranked.map(r => r.path)).toEqual([fresh]);
  });

  test("without a timestamp, a file keeps its mtime as its clock", () => {
    const stub = write("stub.jsonl", [meta("mode")], NOW - 5 * 60_000);
    const [only] = rankByLastEvent([{ path: stub, mtimeMs: NOW - 5 * 60_000 }], 1);
    expect(only.lastEventMs).toBeNull();
  });
});

describe("clockLabel", () => {
  test("one clock when they agree, both when they disagree by minutes", () => {
    expect(clockLabel(30, 60)).toBe("last write 30s ago");
    expect(clockLabel(1800, 151_200)).toBe("last write 30m ago  ·  last event 42.0h ago");
    expect(clockLabel(30, null)).toBe("last write 30s ago");
  });
});
