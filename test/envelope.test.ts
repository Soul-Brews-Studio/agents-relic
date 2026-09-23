import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripLeadingEnvelope } from "../src/types.js";
import { parseClaude } from "../src/shapes/claude.js";
import { probe } from "../src/lineage.js";

// #68: channel-plugin sessions were named, and handed off, as a sliced XML fragment.
const ATTRS = 'source="plugin:discord:discord" chat_id="1512079809021214730" message_id="1540006806481535127" ' +
              'user="nazt_" user_id="691531480689541170" ts="2026-08-20T14:37:14.608Z"';
const CHANNEL = `<channel ${ATTRS}>can you check why the relay drops messages</channel>`;

describe("stripLeadingEnvelope", () => {
  test("keeps what a channel envelope wraps", () => {
    expect(stripLeadingEnvelope(CHANNEL)).toBe("can you check why the relay drops messages");
  });
  test("keeps what a teammate envelope wraps", () => {
    expect(stripLeadingEnvelope('<teammate-message teammate_id="r" summary="x">the uid collides</teammate-message>'))
      .toBe("the uid collides");
  });
  test("an opening tag longer than 200 chars with no > is removed to the end", () => {
    expect(stripLeadingEnvelope(`<channel ${ATTRS} ${"x=\"y\" ".repeat(30)}`)).toBe("");
  });
  test("stacked envelopes are all removed", () => {
    expect(stripLeadingEnvelope(`<channel ${ATTRS}><hook_prompt id="1">go</hook_prompt></channel>`)).toBe("go");
  });
  test("text after the envelope survives", () => {
    expect(stripLeadingEnvelope(`<channel ${ATTRS}>first</channel> and more`)).toBe("first  and more");
  });
  test("prose is returned byte-for-byte", () => {
    for (const t of ["why is a < b in this sort", "  leading space kept", "<3 you", "use a <div> here", "x > y"])
      expect(stripLeadingEnvelope(t)).toBe(t);
  });
  test("tags later code reads are left alone", () => {
    for (const t of ["<command-name>/dig</command-name>", "<local-command-caveat>Caveat: x</local-command-caveat>",
                     "<INSTRUCTIONS>be careful", "<environment_context> cwd"])
      expect(stripLeadingEnvelope(t)).toBe(t);
  });
});

describe("the envelope is gone before anything is cut to size", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "relic-envelope-"));
    const rec = (seq: number, role: string, text: string) => JSON.stringify({
      type: role, sessionId: "s", cwd: "/work/repo", timestamp: `2026-09-23T01:0${seq}:00.000Z`,
      message: { role, content: role === "user" ? text : [{ type: "text", text }] },
    });
    // The attributes alone run past the 200-char description budget.
    const long = `<channel ${ATTRS} attachment_count="1" attachments="${"a".repeat(60)}">please fix the relay</channel>`;
    writeFileSync(join(dir, "s.jsonl"), [rec(1, "user", long), rec(2, "assistant", "on it")].join("\n") + "\n");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test("the import-time description keeps the human's words", async () => {
    const p = await parseClaude(join(dir, "s.jsonl"));
    expect(p.description).toBe("please fix the relay");
  });

  test("lineage picks the words as the prompt", () => {
    expect(probe(join(dir, "s.jsonl"), "s").prompt).toBe("please fix the relay");
  });

  test("tail --handoff prints the words, not the envelope", async () => {
    const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "tail", join(dir, "s.jsonl"), "--handoff"],
                           { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    expect(out).toContain("please fix the relay");
    expect(out).not.toContain("<channel");
  });
});
