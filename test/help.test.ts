import { expect, test, describe } from "bun:test";
import { helpText } from "../src/help.js";

/*
 * THIS FILE EXISTS BECAUSE IMPORTING IT IS THE TEST.
 *
 * The help text is a template literal. A backtick inside it ends the string, and the
 * next identifier becomes a syntax error:
 *
 *     error: Expected ")" but found "vaults"
 *     error: Expected ")" but found "sessions"
 *
 * That took the whole CLI down FOUR times in one week — `relic --help`, `relic index`,
 * every command — and each time it was found by a human running the binary, never by
 * the suite. The reason is structural: it lived in cli.ts, which RUNS A COMMAND AT
 * IMPORT TIME, so no test could import it without executing the CLI. Nothing parsed
 * the file.
 *
 * Moving it to its own module makes the parse itself testable. If help.ts stops
 * parsing, this import throws and the suite is red before anyone ships.
 */
describe("the help text parses and is whole", () => {
  test("it parses at all — the four-times bug", () => {
    expect(typeof helpText()).toBe("string");
  });

  test("every command the dispatcher knows is documented", () => {
    /*
     * The other half of the failure mode: a command added to the dispatch chain but
     * never to the help is invisible. Read the dispatcher from source rather than
     * importing cli.ts, which would run it.
     */
    const src = Bun.file(new URL("../src/cli.ts", import.meta.url)).text();
    return src.then(text => {
      const cmds = [...text.matchAll(/cmd === "([a-z-]+)"/g)].map(m => m[1]);
      expect(cmds.length).toBeGreaterThan(10);
      const help = helpText();
      // Matched anywhere in the leading command column, not anchored to its start —
      // aliases share one line (`now|live`), and demanding each start a line would
      // force a duplicate entry for every alias.
      const missing = [...new Set(cmds)].filter(c => !new RegExp(`^\\s{2}\\S*\\b${c}\\b`, "m").test(help));
      expect(missing).toEqual([]);
    });
  });

  test("it names the index root, so the interpolation still runs", () => {
    // helpText() calls defaultRoot(). A literal that lost its ${} would still parse.
    expect(helpText()).toContain("/banks/<bank>/github.com/<org>/<repo>/");
  });
});
