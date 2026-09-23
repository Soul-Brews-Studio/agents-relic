import { expect, test, describe } from "bun:test";
import { dur, handoffStats } from "../src/time.js";
import { handoffBudget, isHarnessTurn, isInboundTurn } from "../src/recap.js";
import { stripEnvelope } from "../src/types.js";

/**
 * `relic tail --handoff` exists so the NEXT session is handed the pacing of this one
 * instead of a column of timestamps to infer it from. These tests pin the arithmetic
 * that carries that meaning — the printing around it is a format, this is the fact.
 */
const at = (iso: string) => iso;

describe("handoffStats", () => {
  test("needs two usable timestamps — one turn has no span", () => {
    expect(handoffStats([])).toBeNull();
    expect(handoffStats([at("2026-09-22T04:00:00Z")])).toBeNull();
    expect(handoffStats([null, undefined, "not a date"])).toBeNull();
  });

  test("span is first to last, regardless of input order", () => {
    const st = handoffStats([
      at("2026-09-22T04:30:00Z"), at("2026-09-22T04:00:00Z"), at("2026-09-22T04:10:00Z"),
    ])!;
    expect(st.spanMs).toBe(30 * 60_000);
  });

  test("ignores unusable stamps instead of poisoning the span with NaN", () => {
    const st = handoffStats([at("2026-09-22T04:00:00Z"), null, "", at("2026-09-22T04:20:00Z")])!;
    expect(st.spanMs).toBe(20 * 60_000);
  });

  /*
   * The reason the median is there at all. Both runs below span the same wall clock and
   * hold the same number of turns; only the SHAPE differs. A mean gap cannot tell them
   * apart well enough to be worth printing — the median can.
   */
  test("median survives one overnight gap; max names it", () => {
    // nine turns a minute apart, then one gap of ten hours
    const burst = ["2026-09-22T00:00:00Z", "2026-09-22T00:01:00Z", "2026-09-22T00:02:00Z",
                   "2026-09-22T00:03:00Z", "2026-09-22T00:04:00Z", "2026-09-22T10:04:00Z"];
    const st = handoffStats(burst)!;
    expect(st.medianGapMs).toBe(60_000);            // still reads as one-minute pacing
    expect(st.maxGapMs).toBe(10 * 3_600_000);       // and the outlier is stated, not hidden
    expect(st.spanMs).toBe(st.maxGapMs + 4 * 60_000);
  });

  test("evenly spaced supervision reads as its real cadence", () => {
    const spaced = ["2026-09-22T00:00:00Z", "2026-09-22T02:00:00Z",
                    "2026-09-22T04:00:00Z", "2026-09-22T06:00:00Z"];
    const st = handoffStats(spaced)!;
    expect(st.medianGapMs).toBe(2 * 3_600_000);
    expect(st.maxGapMs).toBe(2 * 3_600_000);
  });

  test("epoch milliseconds work as well as ISO strings", () => {
    const base = Date.parse("2026-09-22T04:00:00Z");
    const st = handoffStats([base, base + 5 * 60_000])!;
    expect(st.spanMs).toBe(5 * 60_000);
  });
});

describe("dur", () => {
  test("seconds under a minute, minutes under an hour, one decimal above", () => {
    expect(dur(45_000)).toBe("45s");
    expect(dur(6 * 60_000)).toBe("6m");
    expect(dur(30 * 3_600_000)).toBe("30.0h");
    expect(dur(10.6 * 3_600_000)).toBe("10.6h");
  });
  test("a nonsense duration prints nothing rather than a nonsense number", () => {
    expect(dur(NaN)).toBe("");
    expect(dur(-1)).toBe("");
  });
});

/*
 * Why the asymmetry exists at all: this human's real turns include "go", "gogogo",
 * "merge all" and "ok this cool!". Each is a decision about a proposal, and human-only
 * output strands every one of them. The assistant comes back as context — smaller,
 * because the next session is about to write its own answers.
 */
describe("handoffBudget", () => {
  test("the human gets the full budget, the assistant about half", () => {
    expect(handoffBudget("user", 220)).toBe(220);
    expect(handoffBudget("assistant", 220)).toBe(110);
  });

  test("a floor of 60 — a shorter cut hides the proposal the human answered", () => {
    expect(handoffBudget("assistant", 40)).toBe(60);
    expect(handoffBudget("assistant", 100)).toBe(60);
    expect(handoffBudget("assistant", 130)).toBe(65);
  });

  test("the human budget is never floored — an explicit --chars is obeyed", () => {
    expect(handoffBudget("user", 40)).toBe(40);
  });
});

/*
 * Both of these were real failures, found by running --handoff on the session that
 * built it — first every reply after a bash-stdout vanished, then "suggest me" was
 * answered by a PR report it had nothing to do with.
 */
describe("isInboundTurn", () => {
  const INBOUND = [
    ["a worker reporting in", "Another Claude session sent a message: <teammate-message teammate_id=\"noise\">"],
    ["a bare teammate message", "<teammate-message teammate_id=\"vaults\">PR #52</teammate-message>"],
    ["a background task finishing", "<task-notification> <task-id>af52c74</task-id>"],
    ["the compaction resume prompt", "Continue from where you left off."],
  ] as const;
  for (const [what, text] of INBOUND)
    test(`${what} starts a new exchange`, () => {
      expect(isInboundTurn(text)).toBe(true);
      expect(isHarnessTurn(text)).toBe(true);   // hidden from the reader either way
    });

  /*
   * The other half, and the reason this is not just isHarnessTurn. These are caused
   * BY the human's turn, so the assistant message after them still belongs to it.
   */
  const CAUSED = [
    ["shell output from a ! command", "<bash-stdout>\u03c8\nCLAUDE.md"],
    ["the skill body the harness pastes", "Base directory for this skill: /Users/x/.claude/skills/dig"],
    ["slash-command expansion", "<command-message>dig</command-message>"],
    ["a system reminder", "<system-reminder>Codebase instructions</system-reminder>"],
  ] as const;
  for (const [what, text] of CAUSED)
    test(`${what} is hidden but does NOT break the exchange`, () => {
      expect(isHarnessTurn(text)).toBe(true);
      expect(isInboundTurn(text)).toBe(false);
    });

  test("a real human turn is neither", () => {
    expect(isHarnessTurn("merge it")).toBe(false);
    expect(isInboundTurn("merge it")).toBe(false);
  });
});

/**
 * Ported from #80 (Yutthakit / ChaiKlang Oracle). A channel plugin wraps every human
 * turn in an envelope of ids and a timestamp. `--handoff` promises the human's turns in
 * full; left in, the envelope spends that budget on metadata.
 */
describe("channel envelope in a handoff turn", () => {
  const ENVELOPE =
    '<channel source="plugin:discord:discord" chat_id="1512079809021214730" ' +
    'message_id="1552137023371083839" user="nazt_" user_id="691531480689541170" ' +
    'ts="2026-09-23T01:58:23.683Z">\nfix the bug and submit a PR\n</channel>';

  test("the request survives, the envelope does not", () => {
    const t = stripEnvelope(ENVELOPE).replace(/\s+/g, " ").trim();
    expect(t).toBe("fix the bug and submit a PR");
  });

  test("it fits a budget the envelope alone would have exhausted", () => {
    // handoffBudget gives a user turn the full allowance; 90 chars is smaller than
    // the envelope's ~180, so before this the request never reached the block.
    const cut = handoffBudget("user", 90);
    const raw = ENVELOPE.replace(/\s+/g, " ").trim();
    expect(raw.slice(0, cut)).not.toContain("fix the bug");

    const cleaned = stripEnvelope(ENVELOPE).replace(/\s+/g, " ").trim();
    expect(cleaned.slice(0, cut)).toContain("fix the bug and submit a PR");
  });

  test("an unclosed envelope is still stripped — description truncates at 200 chars", () => {
    const t = stripEnvelope('<channel source="plugin:discord:discord" user="nazt_">\nready?')
      .replace(/\s+/g, " ").trim();
    expect(t).toBe("ready?");
  });

  test("a turn with no envelope is returned unchanged, Thai included", () => {
    const plain = "ลองแล้ว — relic lineage ยังไม่มีในเครื่องผม";
    expect(stripEnvelope(plain)).toBe(plain);
  });
});
