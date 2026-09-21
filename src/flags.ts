/**
 * Argument parsing, as its OWN module.
 *
 * It lived in cli.ts, which runs a command at import time, so no test could reach it
 * — the same structural gap that let a stray backtick in the help text kill the whole
 * CLI four times. Parsing now has real logic (short flags, `=` forms, value-vs-boolean),
 * and logic nobody can test is logic that drifts.
 */
export function flags(argv: string[]) {
  const f: Record<string, string | boolean> = {};
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [k, v] = a.slice(2).split("=");
      if (v !== undefined) f[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) f[k] = argv[++i];
      else f[k] = true;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      /*
       * Single-letter short flags — `-n 10`.
       *
       * Without this they fell through to `pos`, so `relic tail <id> -n 3` silently
       * ignored the 3 AND handed the command two extra positionals. A flag that
       * becomes an argument is worse than an unknown-flag error: nothing complains
       * and the default is used.
       *
       * Anchored to ONE letter so a negative number stays a positional.
       */
      const k = a.slice(1);
      if (argv[i + 1] && !argv[i + 1].startsWith("-")) f[k] = argv[++i];
      else f[k] = true;
    } else pos.push(a);
  }
  return { f, pos };
}
