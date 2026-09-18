import { expect, test, describe } from "bun:test";
import { localDateTime, localTime, localDate } from "../src/time.js";
import { encodeProjectDir, encodeOmpDir } from "../src/live.js";
import { locationOf, shardDirFor, DEFAULT_BANK } from "../src/repo.js";
import { classify } from "../src/noise.js";
import { nameOf, looksLikeId, toISO, dedupeHits, groupByBank, maxISO,
         sessionIdOfPath } from "../src/query.js";
import { buildTree, renderTree, commonPrefix } from "../src/tree.js";
import { kindOf } from "../src/discover.js";

/**
 * Pure-function tests — no LanceDB, no filesystem, no fixtures.
 *
 * Every case here is a bug that ACTUALLY SHIPPED and was found by hand. This file
 * exists so the next one is caught by `bun test` instead of by someone noticing a
 * wrong number hours later.
 */

describe("time — storage is UTC, display is local (the 7-hour split)", () => {
  // `session` sliced the stored ISO (UTC) while `dig` converted to local, so the same
  // session reported 10:06 and 17:06. One formatter, or they drift again.
  test("formats a UTC ISO through the local formatter", () => {
    const iso = "2026-09-16T10:06:00.000Z";
    expect(localDateTime(iso)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(localTime(iso)).toMatch(/^\d{2}:\d{2}$/);
    expect(localDate(iso)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("localDateTime and localTime agree on the same instant", () => {
    const iso = "2026-09-16T10:06:00.000Z";
    expect(localDateTime(iso).slice(11)).toBe(localTime(iso));
  });

  test("unparseable input returns the raw value, never a fabricated date", () => {
    expect(localDateTime("not-a-date")).toBe("not-a-date");
    expect(localTime("")).toBe("");
  });
});

describe("cwd encoding — each agent encodes differently", () => {
  const cwd = "/opt/Code/github.com/laris-co/neo-oracle";

  // Claude maps BOTH "/" and "." to "-"; omp keeps dots and wraps in "--".
  // Using one encoder on the other's root silently matches nothing, which is
  // indistinguishable from "that agent has no session here".
  test("claude maps / and . to -", () => {
    expect(encodeProjectDir(cwd)).toBe("-opt-Code-github-com-laris-co-neo-oracle");
  });

  test("omp keeps dots and wraps in --", () => {
    expect(encodeOmpDir(cwd)).toBe("--opt-Code-github.com-laris-co-neo-oracle--");
  });

  test("the two encoders never agree", () => {
    expect(encodeProjectDir(cwd)).not.toBe(encodeOmpDir(cwd));
  });
});

describe("locationOf — org/repo/project/worktree/dir", () => {
  const base = "/opt/Code/github.com/laris-co/neo-oracle/wt/neo-jsonl-big-boss-16sep-wed2026";

  test("plain vault note has no project", () => {
    const l = locationOf(`${base}/ψ/memory/learnings/x.md`);
    expect(l.org).toBe("laris-co");
    expect(l.repo).toBe("neo-oracle");
    expect(l.project).toBe("");
    expect(l.worktree).toBe("neo-jsonl-big-boss-16sep-wed2026");
    expect(l.dir).toBe("ψ/memory/learnings");
  });

  // The bug this facet exists for: another oracle's ENTIRE vault nested inside this
  // one (4,439 notes) attributed to the HOST repo, so searching arra's memory
  // returned it labelled as neo's.
  test("nested oracle vault carries its own project", () => {
    const l = locationOf(`${base}/ψ/soul-brews-studio/arra-oracle-v3/memory/y.md`);
    expect(l.repo).toBe("neo-oracle");
    expect(l.project).toBe("arra-oracle-v3");
  });

  test("lab and incubate both yield the project", () => {
    expect(locationOf(`${base}/ψ/lab/agents-relic/README.md`).project).toBe("agents-relic");
    expect(locationOf(`${base}/ψ/incubate/Soul-Brews-Studio/agents-relic/origin/src/cli.ts`).project)
      .toBe("agents-relic");
  });

  test("dir excludes the worktree segment and the filename", () => {
    const l = locationOf(`${base}/ψ/inbox/msg.md`);
    expect(l.dir).toBe("ψ/inbox");
    expect(l.dir).not.toContain("wt/");
    expect(l.dir).not.toContain(".md");
  });

  test("a path outside github.com yields nothing rather than a guess", () => {
    const l = locationOf("/tmp/somewhere/else.md");
    expect(l.org).toBe("");
    expect(l.repo).toBe("");
  });
});

describe("noise.classify — prose is never noise", () => {
  // Three rules were wrong on first write. One compared against MAX_TEXT (16000) when
  // the cap is 4000 and matched nothing; one ate a tokenizer's source code; one used
  // length as a proxy and would have deleted real results.
  test("prose roles are never dropped, whatever they contain", () => {
    for (const role of ["user", "assistant", "thinking", "system"]) {
      const v = classify("[tool_use Read] {\"file_path\":\"/x\"}", role);
      expect(v.skip).toBe(false);
    }
  });

  test("a navigation-only tool_use is dropped", () => {
    expect(classify('[tool_use Read] {"file_path":"/x"}', "tool_use").skip).toBe(true);
  });

  test("a file readback is detected by ascending line numbers, not by length", () => {
    // MUST exceed 500 chars — the rule is (tool_result && >500 && ascending numbers).
    // My first version of this fixture was ~294 chars and failed for that reason, not
    // because the rule was broken. A too-small fixture makes a working rule look wrong.
    const dump = "[tool_result] " + Array.from({ length: 60 },
      (_, i) => `${i + 1}→some source code line with enough text to matter`).join("\n");
    expect(classify(dump, "tool_result").skip).toBe(true);
    // Long output WITHOUT line numbers must survive — a metrics table is not a dump.
    const table = "[tool_result] " + "some genuine long output. ".repeat(60);
    expect(classify(table, "tool_result").skip).toBe(false);
  });
});

describe("nameOf — slash-command markup must not become the session name", () => {
  test("promotes the command name out of its wrapper", () => {
    const r: any = { title: "", description: "<command-message>dig</command-message><command-name>/dig</command-name>" };
    expect(nameOf(r)).toBe("/dig");
  });

  test("an UNTERMINATED caveat block is still stripped", () => {
    // description is truncated at 200 chars, so the closing tag is often missing —
    // the non-greedy match failed and the boilerplate became the name.
    const r: any = { title: "", description: "<local-command-caveat>Caveat: The messages below were generated" };
    expect(nameOf(r)).toBe("(untitled)");
  });

  test("a real title always wins", () => {
    expect(nameOf({ title: "Jsonl app in ralph-dig", description: "x" } as any))
      .toBe("Jsonl app in ralph-dig");
  });
});

describe("looksLikeId — decides id-lookup vs name-lookup", () => {
  test("hex uuids and prefixes are ids", () => {
    expect(looksLikeId("04d1d650")).toBe(true);
    expect(looksLikeId("04d1d650-031a-44f6-9c22-3e400e68390f")).toBe(true);
  });

  test("names are not ids", () => {
    expect(looksLikeId("ralph-dig")).toBe(false);
    expect(looksLikeId("Jsonl app")).toBe(false);
  });
});

describe("toISO — relative spans, bare dates, passthrough", () => {
  test("a bare date becomes an inclusive range end when asked", () => {
    expect(toISO("2026-09-01")).toBe("2026-09-01T00:00:00Z");
    expect(toISO("2026-09-01", true)).toBe("2026-09-01T23:59:59Z");
  });

  test("relative spans resolve to an instant", () => {
    expect(toISO("7d")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("empty input is undefined, not epoch zero", () => {
    expect(toISO("")).toBeUndefined();
    expect(toISO(undefined)).toBeUndefined();
  });
});

describe("dedupeHits — the key is content, NOT uid", () => {
  // uidOf(shape, basename, seq) hashes a LINE SLOT. A resumed Claude session writes a new
  // file under the SAME uuid holding NONE of the earlier lines, so one uid can name two
  // different events. Measured: of 13 projects∩projects-1sep pairs, 8 diverge at line 1,
  // and one pair had 1,018 slots carrying an indexed event in BOTH copies.
  test("keeps two DIFFERENT events that share a uid", () => {
    const out = dedupeHits([
      { uid: "same", ts: "2026-09-01T00:00:00Z", role: "user", text: "old session line 1" },
      { uid: "same", ts: "2026-09-12T00:00:00Z", role: "user", text: "resumed session line 1" },
    ]);
    expect(out.length).toBe(2);
  });

  test("collapses the same event arriving from two banks", () => {
    const out = dedupeHits([
      { uid: "a", ts: "2026-09-01T00:00:00Z", role: "user", text: "hello" },
      { uid: "a", ts: "2026-09-01T00:00:00Z", role: "user", text: "hello" },
    ]);
    expect(out.length).toBe(1);
  });

  test("keeps the FIRST occurrence, so the best-ranked copy survives the sort", () => {
    const out = dedupeHits([
      { uid: "a", ts: "t", role: "user", text: "x", tag: "best" },
      { uid: "b", ts: "t", role: "user", text: "x", tag: "worse" },
    ] as any);
    expect((out[0] as any).tag).toBe("best");
  });

  test("falls back to uid only when there is no timestamp", () => {
    // vault/memory carry no ts and hash the FULL path into the uid, so uid there really
    // does identify one chunk of one file.
    const out = dedupeHits([
      { uid: "note-1", ts: "", role: "note", text: "" },
      { uid: "note-1", ts: "", role: "note", text: "" },
      { uid: "note-2", ts: "", role: "note", text: "" },
    ]);
    expect(out.length).toBe(2);
  });

  test("two distinct untimestamped rows are NOT collapsed by empty content", () => {
    const out = dedupeHits([
      { uid: "x", ts: "", role: "note", text: "" },
      { uid: "y", ts: "", role: "note", text: "" },
    ]);
    expect(out.length).toBe(2);
  });
});

describe("shardDirFor — the bank is the top segment", () => {
  test("bank comes before the repo key", () => {
    expect(shardDirFor("github.com/acme/repo", "/data", false, "projects"))
      .toBe("/data/banks/projects/github.com/acme/repo");
  });

  test("an unresolved repo still lands inside its bank", () => {
    expect(shardDirFor(null, "/data", false, "codex")).toBe("/data/banks/codex/_unresolved");
  });

  test("a caller with no bank does not write to the data root itself", () => {
    expect(shardDirFor("github.com/acme/repo", "/data")).toBe(`/data/banks/${DEFAULT_BANK}/github.com/acme/repo`);
  });

  test("in-repo puts the bank INSIDE .relic, so one checkout can hold several", () => {
    const d = shardDirFor("github.com/acme/repo", null, true, "projects-archive");
    expect(d.endsWith("github.com/acme/repo/.relic/banks/projects-archive")).toBe(true);
  });
});

describe("sessionIdOfPath — the uuid is at a different depth in every shape", () => {
  // The basename IS the uuid for exactly one of the four claude/codex layouts. Parsing
  // the basename instead of the path made a subagent file report its AGENT NAME where a
  // session id belongs, which reads as a valid answer and is not one.
  test("claude session: uuid is the basename", () => {
    expect(sessionIdOfPath("/r/-opt-Code-x/04d1d650-031a-44f6-9c22-3e400e68390f.jsonl"))
      .toBe("04d1d650-031a-44f6-9c22-3e400e68390f");
  });
  test("claude subagent: uuid is two directories up, NOT the basename", () => {
    expect(sessionIdOfPath("/r/-opt-x/04d1d650-031a-44f6-9c22-3e400e68390f/subagents/fable-uid.jsonl"))
      .toBe("04d1d650-031a-44f6-9c22-3e400e68390f");
  });
  test("claude workflow_agent: uuid is four directories up", () => {
    expect(sessionIdOfPath(
      "/r/-opt-x/04d1d650-031a-44f6-9c22-3e400e68390f/subagents/workflows/wf_abc/agent-7.jsonl"))
      .toBe("04d1d650-031a-44f6-9c22-3e400e68390f");
  });
  test("codex rollout: uuid sits after a timestamp in the basename", () => {
    expect(sessionIdOfPath("/c/sessions/2026/09/18/rollout-2026-09-18T10-00-00-04d1d650-031a-44f6-9c22-3e400e68390f.jsonl"))
      .toBe("04d1d650-031a-44f6-9c22-3e400e68390f");
  });
  test("omp has no uuid — the id is what follows the underscore", () => {
    expect(sessionIdOfPath("/o/--opt-x--/20260918T100000_abc123.jsonl", "omp")).toBe("abc123");
  });
  test("a vault note has no session at all", () => {
    expect(sessionIdOfPath("/repo/psi/memory/learnings/2026-09-18_thing.md")).toBe("");
  });
  test("uppercase uuid normalises to lowercase", () => {
    expect(sessionIdOfPath("/r/p/04D1D650-031A-44F6-9C22-3E400E68390F.jsonl"))
      .toBe("04d1d650-031a-44f6-9c22-3e400e68390f");
  });
});

describe("groupByBank — bank first, because a flat list hides why a repo repeats", () => {
  const rows = [
    { bank: "projects",        repo: "github.com/a/x", events: 10, sessions: 1, lastIndexed: "2026-09-18T10:00:00Z", newestSession: "2026-09-01T00:00:00Z" },
    { bank: "projects-archive",repo: "github.com/a/x", events:  9, sessions: 9, lastIndexed: "2026-09-17T10:00:00Z", newestSession: "2026-09-16T00:00:00Z" },
    { bank: "projects",        repo: "github.com/a/y", events: 50, sessions: 5, lastIndexed: "2026-09-18T12:00:00Z", newestSession: "2026-09-18T00:00:00Z" },
  ];
  test("groups by bank, biggest bank first", () => {
    const g = groupByBank(rows);
    expect(g.map(b => b.bank)).toEqual(["projects", "projects-archive"]);
    expect(g[0].events).toBe(60);
    expect(g[0].sessions).toBe(6);
    expect(g[0].shards).toBe(2);
  });
  test("the SAME repo in two banks stays two rows — it is two shards", () => {
    const g = groupByBank(rows);
    const repos = g.flatMap(b => b.rows.map(r => r.repo));
    expect(repos.filter(r => r === "github.com/a/x").length).toBe(2);
  });
  test("rows inside a bank are biggest first", () => {
    expect(groupByBank(rows)[0].rows.map(r => r.repo)).toEqual(["github.com/a/y", "github.com/a/x"]);
  });
  test("a bank folds to the NEWEST timestamp in it, not the first seen", () => {
    const g = groupByBank(rows);
    expect(g[0].lastIndexed).toBe("2026-09-18T12:00:00Z");
    expect(g[0].newestSession).toBe("2026-09-18T00:00:00Z");
  });
});

describe("maxISO — an absent timestamp must not win", () => {
  test("picks the newest", () => {
    expect(maxISO(["2026-09-01T00:00:00Z", "2026-09-18T00:00:00Z"])).toBe("2026-09-18T00:00:00Z");
  });
  test("empty and undefined lose to any real value", () => {
    expect(maxISO(["", undefined, "2026-01-01T00:00:00Z"])).toBe("2026-01-01T00:00:00Z");
  });
  test("all-empty is empty, NOT undefined — callers render it as 'never'", () => {
    expect(maxISO(["", undefined])).toBe("");
    expect(maxISO([])).toBe("");
  });
});

describe("session tree — the shape a flat listing hides", () => {
  const entries = [
    { path: "s.jsonl",                                  label: "17:06 session 3,353 ev",        weight: 3353 },
    { path: "subagents/agent-a.jsonl",                  label: "13:33 subagent 141 ev",         weight: 141 },
    { path: "subagents/workflows/wf_one/agent-x.jsonl", label: "17:30 workflow_agent 86 ev",    weight: 86 },
    { path: "subagents/workflows/wf_one/agent-y.jsonl", label: "17:47 workflow_agent 78 ev",    weight: 78 },
    { path: "subagents/workflows/wf_two/agent-z.jsonl", label: "17:43 workflow_agent 9 ev",     weight: 9 },
  ];

  test("a directory sums the weight of everything beneath it", () => {
    // Nine agents in parallel and nine in sequence look identical in a flat list;
    // the run directory's totals are what distinguish them.
    const root = buildTree(entries);
    const wfOne = root.children.get("subagents")!.children.get("workflows")!.children.get("wf_one")!;
    expect(wfOne.files).toBe(2);
    expect(wfOne.weight).toBe(164);
    const workflows = root.children.get("subagents")!.children.get("workflows")!;
    expect(workflows.files).toBe(3);
    expect(workflows.weight).toBe(173);
  });

  test("the root counts every file, including the parent transcript", () => {
    const root = buildTree(entries);
    expect(root.files).toBe(5);
    expect(root.weight).toBe(3353 + 141 + 86 + 78 + 9);
  });

  test("a leaf carries the caller's own label, not a fixed set of columns", () => {
    // pending files have a state and a size; indexed transcripts have an event count.
    // One renderer, because the leaf label is opaque to it.
    const root = buildTree(entries);
    expect(root.children.get("s.jsonl")!.leaf!.label).toBe("17:06 session 3,353 ev");
  });

  test("directories sort before files, so a run is never buried under siblings", () => {
    const lines: string[] = [];
    renderTree(buildTree(entries), "", 8, l => lines.push(l));
    const dirIdx = lines.findIndex(l => l.includes("subagents/"));
    const fileIdx = lines.findIndex(l => l.includes("s.jsonl"));
    expect(dirIdx).toBeLessThan(fileIdx);
  });

  test("limitPerDir truncates and says how many it hid", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      ({ path: `subagents/workflows/wf_one/agent-${i}.jsonl`, label: `x ${i}`, weight: i }));
    const lines: string[] = [];
    renderTree(buildTree(many), "", 3, l => lines.push(l));
    expect(lines.some(l => l.includes("and 9 more"))).toBe(true);
  });

  test("commonPrefix finds the deepest shared directory", () => {
    expect(commonPrefix(["/a/b/c/x.jsonl", "/a/b/c/y.jsonl"])).toBe("/a/b/c/");
    expect(commonPrefix(["/a/b/c/x.jsonl", "/a/b/d/y.jsonl"])).toBe("/a/b/");
    expect(commonPrefix(["/only/one.jsonl"])).toBe("/only/");
    expect(commonPrefix([])).toBe("");
  });
});

describe("kind vs tier — one column was holding two axes", () => {
  // `tier` answered "where in the hierarchy" AND "what kind of thing", so the default
  // filter (tier = 'session' OR tier = 'note') read as "the main tiers" while actually
  // meaning "one tier plus one kind". A tier default of "session" once hid 10,000
  // freshly indexed vault notes while the result count looked perfectly healthy.
  test("every transcript position is the same KIND", () => {
    expect(kindOf("session", "claude-live")).toBe("transcript");
    expect(kindOf("subagent", "claude-live")).toBe("transcript");
    expect(kindOf("workflow_agent", "claude-live")).toBe("transcript");
  });

  test("a document is not a tier", () => {
    expect(kindOf("note", "oracle-vault")).toBe("note");
    expect(kindOf("memory", "claude-memory")).toBe("memory");
  });

  test("source decides before tier, or hermes is filed as a transcript", () => {
    // hermes rows carry tier "session" while being chat messages. Reading tier first
    // would make every one of them a transcript, which is the bug in miniature.
    expect(kindOf("session", "hermes")).toBe("message");
  });

  test("an unknown tier degrades to transcript, not to an empty string", () => {
    // "" is reserved to mean "this row predates the column" — a new value must never
    // collide with that, or old-shard fallback logic starts firing on new rows.
    expect(kindOf("something-new", "claude-live")).toBe("transcript");
    expect(kindOf("session", "claude-live")).not.toBe("");
  });
});
