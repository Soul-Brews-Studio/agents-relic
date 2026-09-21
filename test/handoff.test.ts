import { expect, test, describe } from "bun:test";
import { dur, handoffStats } from "../src/time.js";

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
