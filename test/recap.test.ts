import { expect, test, describe } from "bun:test";
import { isHarnessTurn } from "../src/recap.js";

/**
 * A recap's spine is the human's turns. The user CHANNEL is not the same thing — the
 * harness writes into it too, and in a long session it outnumbers the human.
 *
 * Measured on one real session while building this: 63 user-channel turns, of which 55
 * were harness. Unfiltered, the first five "questions asked" were the tooling
 * describing itself. Each filter added revealed the next shape — slash-command
 * expansion, then skill bodies, then task notifications, then the compaction resume
 * prompt — so this list is evidence, not design.
 */
describe("isHarnessTurn", () => {
  const HARNESS = [
    ["slash-command expansion", "<command-message>dig</command-message>"],
    ["the skill body the harness pastes", "Base directory for this skill: /Users/x/.claude/skills/dig"],
    ["background task finishing", "<task-notification> <task-id>af52c74</task-id>"],
    ["the compaction resume prompt", "Continue from where you left off."],
    ["a continued-session banner", "This session is being continued from a previous conversation that ran out of context."],
    ["a local command's caveat", "<local-command-caveat>Caveat: the messages below"],
    ["a system reminder", "<system-reminder>Codebase instructions</system-reminder>"],
    ["a Codex host preamble", "<recommended_plugins> Here is a list"],
    ["a subagent reporting its result", "Another Claude session sent a message: <teammate-message teammate_id=\"noise\">"],
    ["a teammate message with no preamble", "<teammate-message teammate_id=\"vaults\" color=\"green\">PR #52 open</teammate-message>"],
  ] as const;
  for (const [what, text] of HARNESS)
    test(`omits ${what}`, () => expect(isHarnessTurn(text)).toBe(true));

  const HUMAN = [
    "check hrdr",
    "peek read all from digger and honcho mcp",
    "do like should create lab",
    "can we index all psi md vault?",
    "why does <system-reminder> show up mid-sentence?",   // mentions a tag, is not one
    "continue from where you left off, but skip the tests",  // not the bare prompt
  ] as const;
  for (const text of HUMAN)
    test(`keeps ${JSON.stringify(text.slice(0, 34))}`, () => expect(isHarnessTurn(text)).toBe(false));

  test("the resume prompt is matched only when it is the WHOLE turn", () => {
    // Anchored both ends on purpose: a human elaborating on it is a real instruction.
    expect(isHarnessTurn("Continue from where you left off.")).toBe(true);
    expect(isHarnessTurn("  Continue from where you left off  ")).toBe(true);
    expect(isHarnessTurn("Continue from where you left off and then deploy")).toBe(false);
  });
});
