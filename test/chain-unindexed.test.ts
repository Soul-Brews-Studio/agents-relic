import { expect, test, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unindexedOf, unindexedHint } from "../src/query.js";
import type { ChainRow } from "../src/chain.js";

/**
 * #72: an index built with --since drops a long session's old subagents, and `chain`
 * then renders "PARENT SESSION · 1.0x parallel" — which reads as "nothing ran". Measured
 * on a real 75-day session: 5 of ~710 subagent transcripts indexed.
 */

const UUID = "aaaaaaaa-0000-4000-8000-000000000000";
const ENC = "-work-repo";
let root: string, dir: string;

const row = (file_path: string): ChainRow =>
  ({ session_uuid: UUID, file_path, project_dir: ENC, repo_key: "github.com/org/repo",
     repo: "projects/github.com/org/repo", tier: "subagent" } as unknown as ChainRow);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "relic-chain-unindexed-"));
  dir = join(root, ENC);
  mkdirSync(join(dir, UUID, "subagents", "workflows", "wf_1"), { recursive: true });
  writeFileSync(join(dir, `${UUID}.jsonl`), "{}\n");
  for (const a of ["agent-a1", "agent-a2", "agent-a3"]) writeFileSync(join(dir, UUID, "subagents", `${a}.jsonl`), "{}\n");
  writeFileSync(join(dir, UUID, "subagents", "workflows", "wf_1", "agent-w1.jsonl"), "{}\n");
  writeFileSync(join(dir, UUID, "subagents", "workflows", "wf_1", "journal.jsonl"), "{}\n");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("unindexedOf", () => {
  test("counts the tree's transcripts on disk that the index has no row for", () => {
    const rows = [row(join(dir, `${UUID}.jsonl`)), row(join(dir, UUID, "subagents", "agent-a1.jsonl"))];
    const u = unindexedOf(rows);
    expect(u).toEqual({ missing: 3, onDisk: 5, repo: "github.com/org/repo" });
    expect(unindexedHint(u!)).toBe("(!) 3 of 5 transcripts in this tree are not indexed — reindex: relic index --repo org/repo");
  });

  test("a fully indexed tree says nothing — journal.jsonl is bookkeeping, not a transcript", () => {
    const paths = [join(dir, `${UUID}.jsonl`),
                   ...["agent-a1", "agent-a2", "agent-a3"].map(a => join(dir, UUID, "subagents", `${a}.jsonl`)),
                   join(dir, UUID, "subagents", "workflows", "wf_1", "agent-w1.jsonl")];
    expect(unindexedOf(paths.map(p => row(p)))).toBeNull();
  });

  test("a tree that is not on this machine is not guessed at", () => {
    expect(unindexedOf([row(`/elsewhere/${ENC}/${UUID}.jsonl`)])).toBeNull();
  });

  test("an unresolved repo gets a reindex hint without --repo", () => {
    expect(unindexedHint({ missing: 1, onDisk: 2, repo: "_unresolved" }))
      .toBe("(!) 1 of 2 transcripts in this tree are not indexed — reindex: relic index");
  });
});
