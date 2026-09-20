import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaude } from "../src/shapes/claude.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-hygiene-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const userLine = (cwd: string, text: string) =>
  line({ type: "user", uuid: "u", sessionId: "s", cwd, timestamp: "2026-09-20T00:00:00Z",
         message: { role: "user", content: text } });

describe("#35 — cwd is an EVENT property, not a file property", () => {
  const f = join(tmp, "two-repos.jsonl");
  writeFileSync(f, userLine("/repo/a", "first repo work here")
                 + userLine("/repo/a", "still the first repo")
                 + userLine("/repo/b", "moved to the second repo"));

  test("each event carries the cwd its own line recorded", async () => {
    // Before this, the parser kept the FIRST cwd and the importer stamped it on every
    // event. Session 2bb9b553: 201 of 4,068 events were in a different worktree and
    // `--worktree` could not reach any of them.
    const p = await parseClaude(f);
    expect(p.events.map(e => e.cwd)).toEqual(["/repo/a", "/repo/a", "/repo/b"]);
  });

  test("the SESSION cwd is still the first one — sharding must not move", async () => {
    // Findable, not attributable. repo_key and the shard still come from p.cwd.
    const p = await parseClaude(f);
    expect(p.cwd).toBe("/repo/a");
  });
});

describe("#36 — a signature-only thinking block must never become an event", () => {
  /*
   * 90.7% of thinking blocks in the corpus are hashed: thinking:"" plus a ~1,160-char
   * signature. relic omits them by two accidents that look like intent —
   * `if (th)` being falsy on "", and nobody having added `signature` to the keys
   * flattenContent reads.
   *
   * Adding `signature` to that list, or changing `if (th)` to `if (th !== undefined)`,
   * puts 32,386 x ~1,160 chars = ~37 MB of base64 into the FTS index, where ICU
   * tokenises it and inflates every document frequency BM25 scores against.
   *
   * NOTHING WOULD FAIL. That is why this test exists.
   */
  const SIG = "CAQS3QYKEAgRGAI4AUIIdG" + "A".repeat(1138);

  test("hashed thinking produces no event at all", async () => {
    const f = join(tmp, "hashed.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: SIG }] } }));
    const p = await parseClaude(f);
    expect(p.events).toEqual([]);
  });

  test("the signature never reaches the text of any event", async () => {
    // Asserted on the TEXT, not just the count: a future change could keep the event
    // (because some other block carried it) and still smuggle the signature in.
    const f = join(tmp, "mixed.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "", signature: SIG },
        { type: "text", text: "the visible answer" },
      ] } }));
    const p = await parseClaude(f);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].text).toBe("the visible answer");
    expect(p.events.some(e => e.text.includes("CAQS3QY"))).toBe(false);
  });

  test("readable thinking IS still indexed — 9.3% of blocks carry real text", async () => {
    // The inverse control. A fix that dropped ALL thinking would pass the two tests
    // above and silently lose 1.8 MB of real reasoning.
    const f = join(tmp, "readable.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "reasoning that a human can read", signature: SIG },
      ] } }));
    const p = await parseClaude(f);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].text).toBe("reasoning that a human can read");
  });
});

import { ephemeralHint, ephemeralNote, bankOfHit } from "../src/ephemeral.js";

describe("#31 — flag paths that are probably already gone", () => {
  test("structural shapes carry their own proof of being session-scoped", () => {
    // The pid is IN the path, so it cannot outlive that process.
    expect(ephemeralHint("wrote /private/tmp/claude-501/-opt-Code/x/out.mp4")?.tier)
      .toBe("structural");
    expect(ephemeralHint("saved to /Users/b/proj/scratchpad/frames/001.png")?.tier)
      .toBe("structural");
  });

  test("a bare /tmp prefix is the WEAK tier, not the same claim", () => {
    // It only correlates: a daemon configured to keep state in /tmp matches too.
    expect(ephemeralHint("config writes to /tmp/daemon.sock")?.tier).toBe("weak");
  });

  test("prose about temp files is not a path", () => {
    // The word, not a path — anchoring at a boundary is what keeps this quiet.
    expect(ephemeralHint("we should clean up tmp files someday")).toBeNull();
    expect(ephemeralHint("the /var/tmpfiles.d unit")).toBeNull();
  });

  test("an ordinary path is never flagged", () => {
    expect(ephemeralHint("/opt/Code/github.com/laris-co/neo-oracle/src/index.ts")).toBeNull();
  });

  test("the note names the HOST-scope, because relic indexes other machines", () => {
    // peer-projects holds 29k files from another account on another box. A path
    // recorded there cannot be stat'd meaningfully from here, so the bank is said out
    // loud rather than implied.
    expect(ephemeralNote("out at /tmp/claude-99/x/scratch.bin", "peer-projects"))
      .toContain("bank peer-projects");
    expect(ephemeralNote("nothing ephemeral here", "peer-projects")).toBe("");
  });
});

describe("bankOfHit — the field that does not exist", () => {
  /*
   * A Hit has no `bank`; the bank is the first segment of `repo`. The first version of
   * this feature read `(h as any).bank`, which compiles, returns undefined, and drops
   * the host note on EVERY hit. The unit tests above could not catch it, because they
   * pass the bank in directly — the gap was between the tested unit and the caller.
   */
  test("pulls the bank out of a shard key", () => {
    expect(bankOfHit("peer-projects/github.com/Arkkra-Co/volt-oracle")).toBe("peer-projects");
    expect(bankOfHit("projects/github.com/laris-co/neo-oracle")).toBe("projects");
  });
  test("an unresolved or bare key yields nothing rather than a wrong bank", () => {
    expect(bankOfHit("_unresolved")).toBeUndefined();
    expect(bankOfHit("")).toBeUndefined();
  });
});
