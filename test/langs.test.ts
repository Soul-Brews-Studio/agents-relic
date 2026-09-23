import { expect, test, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LanceStore } from "../src/store/lance.js";
import { shardDirFor } from "../src/repo.js";
import { uidOf } from "../src/types.js";
import { MEASURED_MODELS } from "../src/embed.js";
import {
  scriptsOf, langOf, englishProse, sampleWhere, scanLangs, recommend, emptyLangs, tallyLang,
  embedCommandFor, renderLangs, MULTILINGUAL_AT,
} from "../src/langs.js";

const tmp = mkdtempSync(join(tmpdir(), "relic-langs-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const THAI = "สวัสดีครับ วันนี้อากาศดีมาก ขอบคุณมาก";
const MIXED = "ใช้ rg แทน grep ทุกครั้ง please check the repo first";   // Thai 14 of 43 letters
const PROSE = "Fix the bug in the parser and add a test for it please";
const CODE = `{"file_path":"/opt/Code/x.ts","old_string":"const a = b","new_string":"const a = c"}`;

describe("scriptsOf — letters per Unicode block", () => {
  test("Thai marks and Latin letters are letters; digits, spaces and punctuation are not", () => {
    const s = scriptsOf("สวัสดี hello 123 !");
    expect(s.thai).toBe(6);        // ส ว ั ส ด ี — the vowel marks sit in the Thai block too
    expect(s.latin).toBe(5);
    expect(s.cjk + s.hangul + s.cyrillic + s.other).toBe(0);
  });
  test("emoji count as nothing", () => {
    expect(Object.values(scriptsOf("🚀🔥 ok")).reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("langOf", () => {
  test.each([
    [THAI, "th"],
    [MIXED, "th+en"],
    [PROSE, "en"],
    [CODE, "latin"],
    ["你好，世界。这是一个测试", "zh/ja"],
    ["안녕하세요 반갑습니다", "ko"],
    ["Привет, как дела у тебя сегодня?", "cyrillic"],
    ["12345 --- !!! 2026-09-23", "none"],
  ])("%s -> %s", (text, want) => expect(langOf(text)).toBe(want));

  test("one Thai word in long English is English, but still counted as carrying Thai", () => {
    const t = "The deploy to white.local finished and all sensors report normally again, ขอบคุณ";
    expect(langOf(t)).toBe("en");
    expect(scriptsOf(t).thai).toBeGreaterThan(0);
  });
});

describe("englishProse", () => {
  test("prose has function words, JSON does not — even when its keys are English", () => {
    expect(englishProse(PROSE)).toBe(true);
    expect(englishProse(CODE)).toBe(false);
  });
  test("a short instruction needs only one", () => expect(englishProse("merge the PR")).toBe(true));
});

describe("sampleWhere — 1 in N by uid", () => {
  test("the range is on the first four hex digits", () => {
    expect(sampleWhere(64)).toEqual({ where: "uid < '0400'", rate: 1 / 64 });
    expect(sampleWhere(1)).toEqual({ where: "", rate: 1 });
    expect(sampleWhere(3).where).toBe("uid < '5555'");
  });

  /*
   * THE PREMISE THE WHOLE SAMPLE RESTS ON: uids are sha1 hex, so the fraction below a
   * cut is the cut itself. If a shape ever minted uids another way, this is where the
   * sample would stop being uniform.
   */
  test("real uids fall below the cut at the rate it claims", () => {
    const n = 64_000;
    const { rate } = sampleWhere(64);
    let hit = 0;
    for (let i = 0; i < n; i++) if (uidOf("claude", `f${i % 97}.jsonl`, i) < "0400") hit++;
    expect(Math.abs(hit / n - rate)).toBeLessThan(0.004);
  });
});

describe("recommend", () => {
  const corpus = (thai: number, en: number) => {
    const r = emptyLangs({ sample: 1 });
    for (let i = 0; i < thai; i++) tallyLang(r, "user", THAI);
    for (let i = 0; i < en; i++) tallyLang(r, "assistant", PROSE);
    r.estimated = r.events;
    return r;
  };

  test("a tenth Thai needs a multilingual model, and every candidate is one", () => {
    const rec = recommend(corpus(10, 90));
    expect(rec.verdict).toBe("multilingual");
    expect(rec.thaiShare).toBeCloseTo(0.1);
    expect(rec.candidates.every(c => c.multilingual)).toBe(true);
    // Ollama first (embed's default provider), ranked by its en-th smoke test.
    expect(rec.candidates[0].model).toBe("bge-m3");
    expect(rec.command).toBe("relic embed --model bge-m3");
    expect(rec.keep).toBe(false);
  });

  test("the threshold is inclusive", () => {
    expect(recommend(corpus(1, 99)).verdict).toBe(MULTILINGUAL_AT <= 0.01 ? "multilingual" : "english");
    expect(recommend(corpus(0, 100)).verdict).toBe("english");
  });

  test("an English corpus gets the fewest dims, and all-minilm first", () => {
    const rec = recommend(corpus(0, 100));
    expect(rec.candidates[0].dim).toBe(384);
    expect(rec.command).toBe("relic embed --model all-minilm");
  });

  test("English-only vectors on a Thai corpus are flagged, and switching says --reset", () => {
    const r = corpus(10, 90);
    r.vectors = [{ model: "ollama:all-minilm", dim: 384, rows: 5, shards: 1, keys: ["projects/a"] }];
    const rec = recommend(r);
    expect(rec.current).toEqual([{ model: "ollama:all-minilm", dim: 384, ok: false, shards: 1, keys: ["projects/a"] }]);
    expect(rec.keep).toBe(false);
    expect(rec.command).toBe("relic embed --model bge-m3 --reset");
  });

  test("multilingual vectors already on disk are kept, not replaced", () => {
    const r = corpus(10, 90);
    r.vectors = [{ model: "st:intfloat/multilingual-e5-small+passage:", dim: 384, rows: 5, shards: 2, keys: ["projects/a", "projects/b"] }];
    const rec = recommend(r);
    expect(rec.keep).toBe(true);
    expect(rec.command).toBe("relic embed --provider st --model intfloat/multilingual-e5-small");
  });

  /*
   * Measured on the live index, 2026-09-23: e5-small in 309 shards and bge-m3 in 3. Both
   * fit a Thai corpus, so "keep" is right, but the advice must not pretend there is one.
   */
  test("two models on disk: keep the one most shards hold, and name where the other sits", () => {
    const r = corpus(10, 90);
    r.events = 100; r.estimated = 100;
    r.vectors = [
      { model: "st:intfloat/multilingual-e5-small+passage:", dim: 384, rows: 900, shards: 309, keys: ["projects/a"] },
      { model: "ollama:bge-m3", dim: 1024, rows: 80, shards: 3, keys: ["projects/x", "projects/y", "projects/z"] },
    ];
    const rec = recommend(r);
    expect(rec.keep).toBe(true);
    expect(rec.command).toBe("relic embed --provider st --model intfloat/multilingual-e5-small");
    const text = renderLangs(r, rec);
    expect(text).toContain("309 shards");
    expect(text).toContain("ollama:bge-m3 is on 3 other shards (projects/x, projects/y, projects/z)");
  });

  test("a trace of another script stays out of the verdict", () => {
    const r = corpus(10, 1989);
    tallyLang(r, "user", "你好，世界。这是一个测试");       // 1 in 2,000: prints as 0.1% only from 1 in 1,000
    expect(recommend(r).reason).not.toContain("another non-Latin script");
  });

  test("nothing eligible recommends nothing", () => {
    const rec = recommend(emptyLangs());
    expect(rec.command).toBe("");
    expect(rec.reason).toBe("nothing eligible in scope");
  });

  test("storage is eligible events x dim x 4 bytes", () => {
    const r = corpus(10, 90);
    r.estimated = 2 ** 20;                        // 1 Mi events
    const bge = recommend(r).candidates.find(c => c.model === "bge-m3")!;
    expect(bge.gib).toBeCloseTo(4);               // 1 Mi x 1024 x 4 B = 4 GiB
  });

  test("every measured model has a real dim and, for multilingual ones, some Thai evidence", () => {
    for (const m of MEASURED_MODELS) {
      expect([384, 768, 1024]).toContain(m.dim);
      if (m.multilingual) expect(m.enTh !== undefined || m.paraphrase !== undefined).toBe(true);
    }
  });
});

describe("embedCommandFor", () => {
  test("reads the provider and model out of a stored id", () => {
    expect(embedCommandFor("ollama:bge-m3")).toBe("relic embed --model bge-m3");
    expect(embedCommandFor("st:intfloat/multilingual-e5-small+passage:"))
      .toBe("relic embed --provider st --model intfloat/multilingual-e5-small");
    expect(embedCommandFor("garbage")).toBe("");
  });
});

describe("scanLangs over a real shard", () => {
  const ev = (seq: number, role: string, text: string, tier = "session") => ({
    uid: uidOf("claude", "s.jsonl", seq), session_uuid: "s", file_path: "/s.jsonl", repo_key: "github.com/o/r",
    seq, role, ts: "", text, source: "claude", tier, kind: "transcript", worktree: "", cwd: "",
    org: "o", project: "", dir: "", mem_type: "", origin_session: "",
  });

  test("counts the same population embed would feed a model", async () => {
    const root = join(tmp, "scan");
    const store = await LanceStore.open(shardDirFor("github.com/o/r", root));
    await store.putEvents([
      ev(1, "user", THAI),
      ev(2, "assistant", PROSE),
      ev(3, "tool_result", CODE),
      ev(4, "user", "short"),                         // under --min-chars: embed skips it, so do we
      ev(5, "assistant", THAI, "subagent"),           // not a main tier
    ]);

    const main = await scanLangs({ dataRoot: root, sample: 1 });
    expect(main.shards).toBe(1);
    expect(main.events).toBe(3);
    expect(main.byLang.th?.events).toBe(1);
    expect(main.byLang.en?.events).toBe(1);
    expect(main.byLang.latin?.events).toBe(1);
    expect(main.anyThai).toBe(1);
    expect(main.byRole.user).toEqual({ events: 1, thai: 1 });
    expect(main.vectors).toEqual([]);

    const all = await scanLangs({ dataRoot: root, sample: 1, mainTiers: false });
    expect(all.events).toBe(4);
    expect(all.anyThai).toBe(2);

    const text = renderLangs(main, recommend(main));
    expect(text).toContain("MULTILINGUAL");
    expect(text).toContain("any Thai");
    expect(text).toContain("vectors  none on disk");
  });

  test("an empty scope says so instead of dividing by zero", async () => {
    const r = await scanLangs({ dataRoot: join(tmp, "nothing-here"), sample: 1 });
    expect(r.shards).toBe(0);
    expect(renderLangs(r, recommend(r))).toContain("nothing eligible");
  });
});
