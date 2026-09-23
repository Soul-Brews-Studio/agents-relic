import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripEnvelope } from "../src/types.js";
import { parseClaude } from "../src/shapes/claude.js";
import { probe } from "../src/lineage.js";

// #68: channel-plugin sessions were named, and handed off, as a sliced XML fragment.
const ATTRS = 'source="plugin:discord:discord" chat_id="1512079809021214730" message_id="1540006806481535127" ' +
              'user="nazt_" user_id="691531480689541170" ts="2026-08-20T14:37:14.608Z"';
const CHANNEL = `<channel ${ATTRS}>can you check why the relay drops messages</channel>`;

describe("stripEnvelope", () => {
  test("keeps what a channel envelope wraps", () => {
    expect(stripEnvelope(CHANNEL)).toBe("can you check why the relay drops messages");
  });
  test("keeps what a teammate envelope wraps", () => {
    expect(stripEnvelope('<teammate-message teammate_id="r" summary="x">the uid collides</teammate-message>'))
      .toBe("the uid collides");
  });
  test("an opening tag longer than 200 chars with no > is removed to the end", () => {
    expect(stripEnvelope(`<channel ${ATTRS} ${"x=\"y\" ".repeat(30)}`)).toBe("");
  });
  test("stacked envelopes are all removed", () => {
    expect(stripEnvelope(`<channel ${ATTRS}><hook_prompt id="1">go</hook_prompt></channel>`)).toBe("go");
  });
  test("text after the envelope survives", () => {
    expect(stripEnvelope(`<channel ${ATTRS}>first</channel> and more`)).toBe("first  and more");
  });
  test("a channel tag later in the turn goes too", () => {
    expect(stripEnvelope(`<channel ${ATTRS}>first</channel>\n<channel ${ATTRS}>second</channel>`).replace(/\s+/g, " "))
      .toBe("first second");
    expect(stripEnvelope("done </channel> ok").replace(/\s+/g, " ")).toBe("done ok");
  });
  test("prose is returned byte-for-byte", () => {
    for (const t of ["why is a < b in this sort", "  leading space kept", "<3 you", "use a <div> here", "x > y",
                     "maw discord access <bot> add <channel-id>"])
      expect(stripEnvelope(t)).toBe(t);
  });
  test("tags later code reads are left alone", () => {
    for (const t of ["<command-name>/dig</command-name>", "<local-command-caveat>Caveat: x</local-command-caveat>",
                     "<INSTRUCTIONS>be careful", "<environment_context> cwd"])
      expect(stripEnvelope(t)).toBe(t);
  });
});

describe("the envelope is gone before anything is cut to size", () => {
  // The attributes alone run past the 200-char description budget.
  const LONG = `<channel ${ATTRS} attachment_count="1" attachments="${"a".repeat(60)}">please fix the relay</channel>`;
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relic-envelope-"));
    const rec = (seq: number, role: string, text: string) => JSON.stringify({
      type: role, sessionId: "s", cwd: "/work/repo", timestamp: `2026-09-23T01:0${seq}:00.000Z`,
      message: { role, content: role === "user" ? text : [{ type: "text", text }] },
    });
    writeFileSync(join(dir, "s.jsonl"), [rec(1, "user", LONG), rec(2, "assistant", "on it")].join("\n") + "\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the import-time description keeps the human's words", async () => {
    const p = await parseClaude(join(dir, "s.jsonl"));
    expect(p.description).toBe("please fix the relay");
  });

  test("the stored event text keeps the raw envelope, byte for byte", async () => {
    // Only names and display strip it. The channel facets (#85, #86) parse it from here.
    const p = await parseClaude(join(dir, "s.jsonl"));
    expect(p.events.find(e => e.role === "user")?.text).toBe(LONG);
  });

  test("lineage picks the words as the prompt", () => {
    expect(probe(join(dir, "s.jsonl"), "s").prompt).toBe("please fix the relay");
  });

  test("tail --handoff at #80's --chars 90 prints the words, not the envelope", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "tail", join(dir, "s.jsonl"), "--handoff", "--chars", "90"],
                           { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("please fix the relay");
    expect(out).not.toContain("<channel");
  });
});
