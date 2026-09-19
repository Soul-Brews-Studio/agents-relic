import { expect, test, describe } from "bun:test";
import { sessionIdFromEnv } from "../src/live.js";

/**
 * Both hosts publish their own session id and relic read neither, so `relic now`
 * inferred by mtime an answer that was sitting in a variable.
 *
 * It matters most for Codex, which the cwd scan CANNOT reach: codex is the only source
 * with `walk: "flat"`, and sessionIn() skips those because there is no project-dir
 * layout to encode a cwd into. Observed on white.local inside a live Codex session —
 * `relic now` reported "no session transcript for this directory" while
 * $CODEX_THREAD_ID held the id.
 *
 * python/tests/test_session_env.py asserts the same pairs.
 */
describe("sessionIdFromEnv", () => {
  const ID = "01a0b746-d27a-7e41-9389-75d59d083fa6";

  test("Claude Code's variable is read", () => {
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: ID })).toEqual({ id: ID, via: "CLAUDE_CODE_SESSION_ID" });
  });
  test("Codex's variable is read", () => {
    expect(sessionIdFromEnv({ CODEX_THREAD_ID: ID })).toEqual({ id: ID, via: "CODEX_THREAD_ID" });
  });
  test("the companion variable is the last resort", () => {
    expect(sessionIdFromEnv({ CODEX_COMPANION_SESSION_ID: ID })?.via).toBe("CODEX_COMPANION_SESSION_ID");
  });
  test("Claude wins when both are set — a companioned session has both", () => {
    // Measured in this very process: CLAUDE_CODE_SESSION_ID and
    // CODEX_COMPANION_SESSION_ID held the SAME id. Order must be deterministic anyway.
    expect(sessionIdFromEnv({ CODEX_THREAD_ID: "aaaaaaaa-1111", CLAUDE_CODE_SESSION_ID: ID })?.via)
      .toBe("CLAUDE_CODE_SESSION_ID");
  });

  test("junk never beats the filesystem scan", () => {
    // These variables are inherited by every child process, so an empty or placeholder
    // value would otherwise shadow a working answer with a confident wrong one.
    for (const v of ["", "   ", "none", "unset", "null", "-", "zzzz"])
      expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: v })).toBeNull();
  });
  test("an unset environment resolves to nothing, not a throw", () => {
    expect(sessionIdFromEnv({})).toBeNull();
  });
  test("both uuid dialects parse — Claude's v4 and Codex's uuidv7", () => {
    expect(sessionIdFromEnv({ CODEX_THREAD_ID: "01a0b746-d27a-7e41-9389-75d59d083fa6" })).not.toBeNull();
    expect(sessionIdFromEnv({ CLAUDE_CODE_SESSION_ID: "04d1d650-031a-44f6-9c22-3e400e68390f" })).not.toBeNull();
  });
});
