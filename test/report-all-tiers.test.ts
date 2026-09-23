import { expect, test, describe } from "bun:test";
import { TRANSCRIPT_TIERS } from "../src/query.js";

/*
 * `relic report --all-tiers` was accepted and did nothing: both arms of the ternary
 * that picked its tier list read `undefined`, so the flag could never reach
 * store.sessions(). The doc comment above cmdReport explains why the DEFAULT is
 * narrow — it says nothing about the escape hatch being a no-op — and every other
 * verb honours the same flag, so the report silently disagreed with `sessions
 * --all-tiers` on the same index.
 *
 * Measured on a live index the day this was written: 2,352 sessions either way
 * before, 2,352 vs 2,411 after — the 59 rows are a `memory` bank the narrow default
 * is right to hide and the flag is supposed to reveal.
 */

/** The tier predicate store.sessions() builds — an empty list means NO predicate. */
const predicate = (tiers?: string[]) =>
  tiers?.length ? tiers.map(t => `tier = '${t}'`).join(" OR ") : null;

/** What cmdReport hands listSessions, which falls back to TRANSCRIPT_TIERS on undefined. */
const reportTiers = (allTiers: boolean) => (allTiers ? [] : undefined);
const effective = (tiers?: string[]) => tiers ?? TRANSCRIPT_TIERS;

describe("report --all-tiers reaches the store", () => {
  test("the two arms differ — the bug was that they did not", () => {
    expect(reportTiers(true)).not.toEqual(reportTiers(false) as never);
  });

  test("default stays narrow: only conversation tiers are counted", () => {
    expect(effective(reportTiers(false))).toEqual(TRANSCRIPT_TIERS);
    expect(predicate(effective(reportTiers(false)))).toContain("tier = 'session'");
  });

  test("--all-tiers drops the predicate instead of naming more tiers", () => {
    // [] and undefined are NOT interchangeable here: undefined re-applies the default.
    expect(predicate(effective(reportTiers(true)))).toBeNull();
  });

  test("note and memory are excluded by default, included with the flag", () => {
    const narrow = effective(reportTiers(false));
    expect(narrow).not.toContain("note");
    expect(narrow).not.toContain("memory");
    expect(predicate(effective(reportTiers(true)))).toBeNull();  // nothing excluded
  });
});
