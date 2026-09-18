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

describe("native/TypeScript parity for the layout commands", () => {
  // These two are the ONLY commands bin/relic-dispatch.sh routes to the binary, so
  // they are the only place a whole command's output can differ by which engine ran.
  // `now` used to be routed too and printed three lines natively against the
  // TypeScript block; it was removed rather than pinned, because the TypeScript `now`
  // already calls the binary for the expensive part.
  const run = async (args: string[]) => {
    const ts = Bun.spawn(["bun", join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts"), ...args],
                         { stdout: "pipe", stderr: "ignore", env: { ...process.env, RELIC_NATIVE: "0" } });
    const nat = Bun.spawn([BIN, ...args], { stdout: "pipe", stderr: "ignore" });
    const [a, b] = await Promise.all([new Response(ts.stdout).text(), new Response(nat.stdout).text()]);
    await Promise.all([ts.exited, nat.exited]);
    return [a.trim().split("\n").sort().join("\n"), b.trim().split("\n").sort().join("\n")];
  };

  test.if(have)("banks agrees", async () => {
    const [ts, nat] = await run(["banks"]);
    expect(nat).toBe(ts);
  });

  test.if(have)("shards --count agrees", async () => {
    const [ts, nat] = await run(["shards", "--count"]);
    expect(nat).toBe(ts);
  });

  test.if(have)("shards full listing agrees row for row", async () => {
    const [ts, nat] = await run(["shards"]);
    expect(nat).toBe(ts);
  });

  test.if(have)("--repo matches the repo portion, not the shard key, in BOTH", async () => {
    // Every key begins with its bank name, so a key-matching implementation would
    // return a whole bank here instead of nothing.
    const [ts, nat] = await run(["shards", "--repo", "projects", "--count"]);
    expect(ts).toBe("0");
    expect(nat).toBe("0");
  });
});
