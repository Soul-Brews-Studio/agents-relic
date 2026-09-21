import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseClaude } from "../src/shapes/claude.js";
import { classify } from "../src/noise.js";
import { importFiles } from "../src/import.js";
import type { Found } from "../src/discover.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-hygiene-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const line = (o: Record<string, unknown>) => JSON.stringify(o) + "\n";
const userLine = (cwd: string, text: string) =>
  line({ type: "user", uuid: "u", sessionId: "s", cwd, timestamp: "2026-09-20T00:00:00Z",
         message: { role: "user", content: text } });

describe("#35 — cwd is an EVENT property, not a file property", () => {
  const f = join(tmp, "two-repos.jsonl");
  writeFileSync(f, userLine("/repo/a", "first repo work here")
                 + userLine("/repo/a", "still the first repo")
                 + userLine("/repo/b", "moved to the second repo"));

  test("each event carries the cwd its own line recorded", async () => {
    // Before this, the parser kept the FIRST cwd and the importer stamped it on every
    // event. Session 2bb9b553: 201 of 4,068 events were in a different worktree and
    // `--worktree` could not reach any of them.
    const p = await parseClaude(f);
    expect(p.events.map(e => e.cwd)).toEqual(["/repo/a", "/repo/a", "/repo/b"]);
  });

  test("the SESSION cwd is still the first one — sharding must not move", async () => {
    // Findable, not attributable. repo_key and the shard still come from p.cwd.
    const p = await parseClaude(f);
    expect(p.cwd).toBe("/repo/a");
  });
});

describe("#36 — a signature-only thinking block must never become an event", () => {
  /*
   * 90.7% of thinking blocks in the corpus are hashed: thinking:"" plus a ~1,160-char
   * signature. relic omits them by two accidents that look like intent —
   * `if (th)` being falsy on "", and nobody having added `signature` to the keys
   * flattenContent reads.
   *
   * Adding `signature` to that list, or changing `if (th)` to `if (th !== undefined)`,
   * puts 32,386 x ~1,160 chars = ~37 MB of base64 into the FTS index, where ICU
   * tokenises it and inflates every document frequency BM25 scores against.
   *
   * NOTHING WOULD FAIL. That is why this test exists.
   */
  const SIG = "CAQS3QYKEAgRGAI4AUIIdG" + "A".repeat(1138);

  test("hashed thinking produces no event at all", async () => {
    const f = join(tmp, "hashed.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: SIG }] } }));
    const p = await parseClaude(f);
    expect(p.events).toEqual([]);
  });

  test("the signature never reaches the text of any event", async () => {
    // Asserted on the TEXT, not just the count: a future change could keep the event
    // (because some other block carried it) and still smuggle the signature in.
    const f = join(tmp, "mixed.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "", signature: SIG },
        { type: "text", text: "the visible answer" },
      ] } }));
    const p = await parseClaude(f);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].text).toBe("the visible answer");
    expect(p.events.some(e => e.text.includes("CAQS3QY"))).toBe(false);
  });

  test("readable thinking IS still indexed — 9.3% of blocks carry real text", async () => {
    // The inverse control. A fix that dropped ALL thinking would pass the two tests
    // above and silently lose 1.8 MB of real reasoning.
    const f = join(tmp, "readable.jsonl");
    writeFileSync(f, line({ type: "assistant", uuid: "u", sessionId: "s", cwd: "/r",
      message: { role: "assistant", content: [
        { type: "thinking", thinking: "reasoning that a human can read", signature: SIG },
      ] } }));
    const p = await parseClaude(f);
    expect(p.events).toHaveLength(1);
    expect(p.events[0].text).toBe("reasoning that a human can read");
  });
});

import { ephemeralHint, ephemeralNote, bankOfHit } from "../src/ephemeral.js";

describe("#31 — flag paths that are probably already gone", () => {
  test("structural shapes carry their own proof of being session-scoped", () => {
    // The pid is IN the path, so it cannot outlive that process.
    expect(ephemeralHint("wrote /private/tmp/claude-501/-opt-Code/x/out.mp4")?.tier)
      .toBe("structural");
    expect(ephemeralHint("saved to /Users/b/proj/scratchpad/frames/001.png")?.tier)
      .toBe("structural");
  });

  test("a bare /tmp prefix is the WEAK tier, not the same claim", () => {
    // It only correlates: a daemon configured to keep state in /tmp matches too.
    expect(ephemeralHint("config writes to /tmp/daemon.sock")?.tier).toBe("weak");
  });

  test("prose about temp files is not a path", () => {
    // The word, not a path — anchoring at a boundary is what keeps this quiet.
    expect(ephemeralHint("we should clean up tmp files someday")).toBeNull();
    expect(ephemeralHint("the /var/tmpfiles.d unit")).toBeNull();
  });

  test("an ordinary path is never flagged", () => {
    expect(ephemeralHint("/opt/Code/github.com/laris-co/neo-oracle/src/index.ts")).toBeNull();
  });

  test("the note names the HOST-scope, because relic indexes other machines", () => {
    // peer-projects holds 29k files from another account on another box. A path
    // recorded there cannot be stat'd meaningfully from here, so the bank is said out
    // loud rather than implied.
    expect(ephemeralNote("out at /tmp/claude-99/x/scratch.bin", "peer-projects"))
      .toContain("bank peer-projects");
    expect(ephemeralNote("nothing ephemeral here", "peer-projects")).toBe("");
  });
});

describe("bankOfHit — the field that does not exist", () => {
  /*
   * A Hit has no `bank`; the bank is the first segment of `repo`. The first version of
   * this feature read `(h as any).bank`, which compiles, returns undefined, and drops
   * the host note on EVERY hit. The unit tests above could not catch it, because they
   * pass the bank in directly — the gap was between the tested unit and the caller.
   */
  test("pulls the bank out of a shard key", () => {
    expect(bankOfHit("peer-projects/github.com/Arkkra-Co/volt-oracle")).toBe("peer-projects");
    expect(bankOfHit("projects/github.com/laris-co/neo-oracle")).toBe("projects");
  });
  test("an unresolved or bare key yields nothing rather than a wrong bank", () => {
    expect(bankOfHit("_unresolved")).toBeUndefined();
    expect(bankOfHit("")).toBeUndefined();
  });
});

import { canonicalRepoKey, repoIndex, repoKeyOf, resolveRepoKey } from "../src/repo.js";

describe("#44 — repo_key must not echo the cwd's casing", () => {
  /*
   * One repo acquired three keys because repoKeyOf echoed whatever the session's cwd
   * used, and `--repo` filters that column exactly:
   *
   *     2,720  github.com/laris-co/DustBoy-Oracle
   *       119  github.com/laris-co/Dustboy-Oracle
   *        10  github.com/laris-co/dustboy-oracle
   *
   * macOS hid it — all three resolved to ONE inode. On Linux it splits into three
   * shard directories holding a third of the history each.
   */
  test("repoKeyOf stays PURE and keeps echoing — that is its contract", () => {
    // If this ever canonicalises, the function has quietly gained a filesystem
    // dependency and is no longer host-independent or trivially testable.
    expect(repoKeyOf("/x/github.com/laris-co/DustBoy-Oracle"))
      .toBe("github.com/laris-co/DustBoy-Oracle");
  });

  test("canonicalRepoKey is idempotent", () => {
    const once = canonicalRepoKey("github.com/laris-co/DustBoy-Oracle");
    expect(canonicalRepoKey(once)).toBe(once);
  });

  test("every casing of one repo resolves to the SAME key", () => {
    /*
     * The fixture comes from repoIndex() itself, not from a repo I happen to have.
     * Hard-coding `dustboy-oracle` asserts about THIS machine's ghq tree — the same
     * environment-dependence that already broke the --source-path and homes tests.
     */
    const anyKey = [...repoIndex().values()].flat()[0];
    if (!anyKey) return;                       // no ghq tree here; nothing to assert
    const flip = (k: string) => k.split("/").map((seg, i) =>
      i < 2 ? seg : seg.toUpperCase()).join("/");
    const keys = new Set([
      resolveRepoKey(`/opt/Code/${anyKey}`),
      resolveRepoKey(`/opt/Code/${flip(anyKey)}/wt/thing`),
      resolveRepoKey(`/Users/someone/Code/${anyKey.toLowerCase()}/x`),
    ]);
    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe(anyKey);         // and it is the tree's OWN spelling
  });

  test("a repo this machine does not have passes through UNCHANGED", () => {
    // Peer roots carry paths from another host. Inventing a spelling for them would be
    // worse than echoing — the key would stop matching the rows already written.
    expect(resolveRepoKey("/opt/Code/github.com/nowhere/not-a-real-repo-xyz"))
      .toBe("github.com/nowhere/not-a-real-repo-xyz");
  });
});

describe("#37 — binary-blob widened from base64-only to any unbroken 120-char run", () => {
  // A genuine base64 blob — what the OLD regex, `/[A-Za-z0-9+/]{120,}={0,2}/`, caught.
  const BASE64_BLOB = "SGVsbG8gd29ybGQhIFRoaXMgaXMgYSBsb25nIGJhc2U2NC1sb29raW5nIHN0cmluZyB0aGF0IHNo"
    + "b3VsZCBiZSBmbGFnZ2VkIGFzIGJpbmFyeSBibG9iIG5vaXNlIGJ5IHRoZSBjbGFzc2lmaWVyLg==";

  test("a real base64 blob is flagged", () => {
    expect(BASE64_BLOB.length).toBeGreaterThanOrEqual(120);
    expect(classify(`[tool_result] ${BASE64_BLOB}`, "tool_result"))
      .toMatchObject({ skip: true, rule: "binary-blob" });
  });

  test("a long unbroken token that is NOT base64 (hex, JWT-shaped) is also flagged", () => {
    // This is the widened behaviour #37 asks for: the old regex would have let both
    // of these through, since neither is pure [A-Za-z0-9+/].
    const hex = "a".repeat(60) + "f".repeat(60); // 120 hex chars, no base64 '+' or '/'
    expect(classify(`[tool_result] ${hex}`, "tool_result"))
      .toMatchObject({ skip: true, rule: "binary-blob" });

    const jwtShaped = "eyJhbGciOiJIUzI1NiJ9." + "x".repeat(80) + "." + "y".repeat(30);
    expect(classify(`[tool_result] ${jwtShaped}`, "tool_result"))
      .toMatchObject({ skip: true, rule: "binary-blob" });
  });

  test("ordinary prose containing a long word is NOT flagged", () => {
    // Prose roles are exempt regardless of shape (classify's early return), so this
    // asserts on tool_result text — the one role the rule actually applies to.
    const prose = "the output looked fine, nothing unusual about it at all, just normal "
      + "sentence after sentence describing what happened during the run in plain words";
    expect(classify(`[tool_result] ${prose}`, "tool_result").skip).toBe(false);

    // A single long word (e.g. a URL-less long identifier) under 120 chars must survive.
    const oneLongWord = "supercalifragilisticexpialidocious".repeat(2); // 70 chars, < 120
    expect(classify(`[tool_result] ${oneLongWord} is a real word apparently`, "tool_result").skip)
      .toBe(false);
  });

  test("prose roles stay exempt even when they contain a 120-char run", () => {
    const hex = "a".repeat(130);
    for (const role of ["user", "assistant", "thinking", "system"])
      expect(classify(hex, role).skip).toBe(false);
  });

  // ---- the --keep-noise opt-out, exercised through the real importer -------------

  const foundWith = (text: string): Found => ({
    path: "/x/blob.jsonl", projectDir: "p", tier: "session", source: "claude",
    workflowRunId: null, agentId: null, mtime: 1, size: 2, bank: "projects37",
    parser: async () => ({
      sessionUuid: "s37", cwd: null, model: "", lines: 1, badLines: 0,
      startedAt: "", endedAt: "", description: "", title: "", gitBranch: "",
      events: [
        { uid: "u1", seq: 1, role: "user", ts: "", text: "a normal prose message" },
        { uid: "u2", seq: 2, role: "tool_result", ts: "", text: "a".repeat(130) },
      ],
    }),
  } as unknown as Found);

  test("skipNoise defaults ON: the importer drops the blob event and keeps the prose one", async () => {
    const root = join(tmp, "keep-noise-off");
    const t = await importFiles([foundWith("a".repeat(130))], { dataRoot: root, inRepo: false, skipNoise: true });
    expect(t.added).toBe(1);           // prose event kept
    expect(t.skippedNoise).toBe(1);    // blob event dropped
  });

  test("--keep-noise (skipNoise: false) restores the old unfiltered behaviour", async () => {
    const root = join(tmp, "keep-noise-on");
    const t = await importFiles([foundWith("a".repeat(130))], { dataRoot: root, inRepo: false, skipNoise: false });
    expect(t.added).toBe(2);           // both events kept, including the blob
    expect(t.skippedNoise).toBe(0);
  });
});

/*
 * The binary-blob rule after #50's review. The PR widened it to "any unbroken run of
 * >= 120 non-whitespace characters", which is a LENGTH test rather than a blob test:
 * measured on 7,067 real events it flagged 678 where the old regex flagged 14, and the
 * 664-event difference was deep file paths, one-line JSON tool results and rg command
 * lines — exactly the content the index exists to find.
 */
describe("#50 review — binary-blob names encodings instead of measuring length", () => {
  const { isBlob } = require("../src/noise.js");

  test("a base64 payload is a blob", () => {
    expect(isBlob("[tool_result] " + "iVBORw0KGgoAAAANSUhEUg".repeat(8))).toBe(true);
  });

  test("a hex digest is a blob", () => {
    expect(isBlob("[tool_result] " + "deadbeef".repeat(20))).toBe(true);
  });

  test("a JWT is a blob, including a minimal 17-character header", () => {
    // eyJhbGciOiJIUzI1NiJ9 is {"alg":"HS256"} — the first pattern required 20 chars
    // after eyJ and missed it.
    expect(isBlob("eyJhbGciOiJIUzI1NiJ9." + "x".repeat(80) + "." + "y".repeat(30))).toBe(true);
  });

  /*
   * The four shapes that made the widened rule unusable. Each one clears 120 unbroken
   * characters and each one is content someone would search for.
   */
  test("a deep file path is NOT a blob", () => {
    const p = "/opt/Code/github.com/laris-co/neo-oracle/wt/neo-jsonl-big-boss-16sep-wed2026/" +
              "ψ/lab/agents-relic/src/store/lance.ts:/opt/Code/github.com/laris-co/neo-oracle/ψ/memory";
    expect(p.length).toBeGreaterThan(120);
    expect(isBlob(`[tool_result] ${p}`)).toBe(false);
  });

  test("a one-line JSON tool result is NOT a blob", () => {
    const j = '{"id":"cli:agent:start","result":{"agent":{"agent":"codex","agent_status":"idle",' +
              '"cwd":"/opt/Code/github.com/laris-co/neo-oracle","focus":true,"session":"abc123"}}}';
    expect(j.length).toBeGreaterThan(120);
    expect(isBlob(`[tool_result] ${j}`)).toBe(false);
  });

  test("a long rg command line is NOT a blob", () => {
    const cmd = "rg -o --no-ignore -e '[a-z-]*opus-4[.-]6[a-z0-9-]*' -e 'Opus' " +
                "~/.claude/projects/-opt-Code-github-com-laris-co-neo-oracle/*.jsonl --glob '!node_modules'";
    expect(isBlob(`[tool_use Bash] {"command":"${cmd}"}`)).toBe(false);
  });

  test("base64url is deliberately not a shape — its alphabet is ordinary identifier text", () => {
    // Flagged a measurement table and a filename dump when it was included.
    expect(isBlob("[tool_result] " + "a_long-identifier_name-with-dashes".repeat(5))).toBe(false);
  });
});
