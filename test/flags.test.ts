import { expect, test, describe } from "bun:test";
import { flags } from "../src/flags.js";

describe("short flags — the silent-positional trap", () => {
  /*
   * `-n 3` used to fall through to `pos`, so `relic tail <id> -n 3` ignored the 3 AND
   * handed the command two extra positionals. A flag that becomes an argument is
   * worse than an unknown-flag error: nothing complains and the default is used.
   */
  test("-n 3 is a flag with a value, not two positionals", () => {
    const { f, pos } = flags(["tail", "abc", "-n", "3"]);
    expect(f.n).toBe("3");
    expect(pos).toEqual(["tail", "abc"]);
  });
  test("a bare short flag is boolean", () => {
    expect(flags(["cmd", "-v"]).f.v).toBe(true);
  });
  test("a NEGATIVE NUMBER stays a positional", () => {
    // Anchored to one letter for exactly this reason.
    const { f, pos } = flags(["cmd", "-5"]);
    expect(f["5"]).toBeUndefined();
    expect(pos).toContain("-5");
  });
  test("-- still wins, and its value is not eaten by a following flag", () => {
    const { f } = flags(["cmd", "--limit", "--json"]);
    expect(f.limit).toBe(true);
    expect(f.json).toBe(true);
  });
});

describe("long flags keep working", () => {
  test("--k=v, --k v, and bare --k", () => {
    const { f, pos } = flags(["search", "query", "--limit=5", "--repo", "neo", "--json"]);
    expect(f.limit).toBe("5");
    expect(f.repo).toBe("neo");
    expect(f.json).toBe(true);
    expect(pos).toEqual(["search", "query"]);
  });
});
