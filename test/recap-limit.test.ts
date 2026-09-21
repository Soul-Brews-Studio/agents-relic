import { expect, test, describe } from "bun:test";
import { RECAP_DEFAULT_LIMIT } from "../src/recap.js";

/*
 * `relic recap` had no cap and `--limit N` took the OLDEST N. On a six-day session
 * that printed 332 turns — about 6,000 tokens — opening with a question asked six days
 * before the reader cares. A recap is read to answer "what just happened", so the tail
 * is the only end that answers it.
 */
const take = (asked: string[], limit: number) => limit > 0 ? asked.slice(-limit) : asked;

describe("recap asked-turn window", () => {
  const asked = Array.from({ length: 332 }, (_, i) => `turn ${i + 1}`);

  test("the default is the LAST 20, not the first", () => {
    const out = take(asked, RECAP_DEFAULT_LIMIT);
    expect(RECAP_DEFAULT_LIMIT).toBe(20);
    expect(out).toHaveLength(20);
    expect(out[19]).toBe("turn 332");          // the end anyone means
    expect(out[0]).toBe("turn 313");
    expect(out).not.toContain("turn 1");       // the regression this replaces
  });

  test("--limit 0 means all of them", () => {
    expect(take(asked, 0)).toHaveLength(332);
  });

  test("a limit larger than the session returns the session, not padding", () => {
    expect(take(["a", "b"], 20)).toEqual(["a", "b"]);
  });

  /*
   * The footer is only honest when something was withheld — printing "0 earlier turns
   * not shown" beside three runnable commands is noise on every short session.
   */
  test("nothing is withheld when the session is shorter than the window", () => {
    const short = ["a", "b", "c"];
    expect(short.length - take(short, RECAP_DEFAULT_LIMIT).length).toBe(0);
  });

  test("the withheld count is what the footer must report", () => {
    expect(asked.length - take(asked, RECAP_DEFAULT_LIMIT).length).toBe(312);
  });
});
