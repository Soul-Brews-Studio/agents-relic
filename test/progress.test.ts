import { expect, test, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { progress, clearLine } from "../src/progress.js";
import { importFiles } from "../src/import.js";
import { parseClaude } from "../src/shapes/claude.js";
import type { Found } from "../src/discover.js";

// #75: piped, prune's 58 \r-frames arrived as one 5,497-byte line.
const sink = (isTTY: boolean) => {
  const out: string[] = [];
  return { isTTY, out, write: (s: string) => { out.push(s); return true; } };
};

describe("progress, piped", () => {
  test("frames become lines, throttled to one per 10% step", () => {
    const s = sink(false);
    const bar = progress(s, 60_000);
    for (let i = 0; i <= 1000; i++) bar.tick(`  ${i / 10}%  ${i}/1000 scanned   `, i / 10);
    bar.clear();
    const text = s.out.join("");
    expect(text).not.toContain("\r");
    const lines = text.split("\n").filter(Boolean);
    expect(lines.length).toBe(11);
    expect(lines.every(l => l.length <= 200 && l === l.trimEnd())).toBe(true);
  });
  test("without a percentage, at most one line per interval", () => {
    const s = sink(false);
    const bar = progress(s, 60_000);
    for (let i = 0; i < 50; i++) bar.tick(`frame ${i}`);
    expect(s.out).toEqual(["frame 0\n"]);
  });
  test("a forced frame always prints — the last one of a phase", () => {
    const s = sink(false);
    const bar = progress(s, 60_000);
    bar.tick("1/3", 33); bar.tick("2/3", 34); bar.tick("3/3", 35, true);
    expect(s.out).toEqual(["1/3\n", "3/3\n"]);
  });
  test("clearLine writes nothing", () => {
    const s = sink(false);
    clearLine(s);
    expect(s.out).toEqual([]);
  });
});

describe("progress, on a terminal", () => {
  test("repaints in place and clears only what it drew", () => {
    const s = sink(true);
    const bar = progress(s);
    bar.clear();
    expect(s.out).toEqual([]);
    bar.tick("a"); bar.tick("b");
    bar.clear();
    expect(s.out.slice(0, 2)).toEqual(["\ra", "\rb"]);
    expect(s.out[2]).toBe("\r" + " ".repeat(96) + "\r");
  });
});

describe("importFiles --progress through a pipe", () => {
  test("no carriage returns and no wall of frames on stderr", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relic-progress-"));
    const found: Found[] = [];
    for (let i = 0; i < 250; i++) {
      const path = join(dir, `s${i}.jsonl`);
      writeFileSync(path, JSON.stringify({ type: "user", sessionId: `s${i}`, cwd: "/work/repo",
        timestamp: "2026-09-23T01:00:00.000Z", message: { role: "user", content: `turn ${i}` } }) + "\n");
      const st = statSync(path);
      found.push({ path, projectDir: "-work-repo", tier: "session", source: "claude-live", bank: "projects",
                   workflowRunId: null, agentId: null, mtime: st.mtimeMs, size: st.size, parser: parseClaude });
    }
    const err = process.stderr as any;
    const origWrite = err.write, origTTY = Object.getOwnPropertyDescriptor(err, "isTTY");
    let captured = "";
    Object.defineProperty(err, "isTTY", { value: false, configurable: true });
    err.write = (s: string) => { captured += s; return true; };
    try {
      await importFiles(found, { dataRoot: join(dir, "index"), inRepo: false, noWrite: true, progress: true });
    } finally {
      err.write = origWrite;
      if (origTTY) Object.defineProperty(err, "isTTY", origTTY); else delete err.isTTY;
      rmSync(dir, { recursive: true, force: true });
    }
    expect(captured).not.toContain("\r");
    expect(captured).toContain("scanned");
    expect(captured.split("\n").every(l => l.length <= 200)).toBe(true);
  });
});
