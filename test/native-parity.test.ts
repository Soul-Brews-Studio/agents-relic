import { expect, test, describe } from "bun:test";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { liveRoots, freshCandidates } from "../src/live.js";

/**
 * The native binary and the in-process scan must answer identically.
 *
 * This is the test that earns the dispatch its right to exist. A faster engine that
 * returns a DIFFERENT answer is worse than no engine at all, because which answer you
 * get then depends on whether a binary happens to be built — and the fast path is the
 * one nobody runs by hand.
 *
 * Skipped, not failed, when the binary is absent: it is strictly optional, and `bunx`
 * must keep working with no Rust toolchain.
 */
const BIN = join(dirname(fileURLToPath(import.meta.url)), "..",
                 "rust", "target", "release", "relic-native");
const have = existsSync(BIN);

const norm = (r: { project: string; uuids: string[] }[]) =>
  JSON.stringify(r.map(x => ({ p: x.project, u: [...x.uuids].sort() }))
                  .sort((a, b) => a.p.localeCompare(b.p)));

describe("native/TypeScript parity for the live scan", () => {
  test.if(have)("both engines return the same candidate set", async () => {
    const roots = liveRoots();
    // A wide window so the comparison has rows to compare on a quiet machine. Both
    // engines see the same instant of the filesystem, give or take the gap between
    // the two calls — which is why the assertion is on SHAPE, and why a uuid that
    // appears between them would show up as a mismatch rather than silently pass.
    process.env.RELIC_NATIVE = "0";
    const ts = await freshCandidates(roots, 86400);
    delete process.env.RELIC_NATIVE;
    const native = await freshCandidates(roots, 86400);
    expect(norm(native)).toBe(norm(ts));
  });

  test.if(have)("RELIC_NATIVE=0 forces the in-process path", async () => {
    process.env.RELIC_NATIVE = "0";
    const r = await freshCandidates(liveRoots(), 3600);
    delete process.env.RELIC_NATIVE;
    expect(Array.isArray(r)).toBe(true);
  });

  test("a missing binary falls back instead of throwing", async () => {
    process.env.RELIC_NATIVE = "/nonexistent/relic-native";
    const r = await freshCandidates(liveRoots(), 3600);
    delete process.env.RELIC_NATIVE;
    expect(Array.isArray(r)).toBe(true);
  });

  test("liveRoots dedupes paths and drops non-transcript layouts", () => {
    const roots = liveRoots();
    // claude-live and claude-memory both name ~/.claude/projects; scanning it twice
    // double-reported every running agent through `relic now --all` and MCP relic_now.
    expect(new Set(roots).size).toBe(roots.length);
    expect(roots.some(r => r.includes(".relic-vault-unset"))).toBe(false);
    expect(roots.some(r => r.endsWith(".hermes"))).toBe(false);
  });
});
