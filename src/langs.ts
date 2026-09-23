import { LanceStore } from "./store/lance.js";
import { pickShards, type Scope } from "./query.js";
import { MEASURED_MODELS, type MeasuredModel } from "./embed.js";

/**
 * `relic langs` — which languages the embeddable corpus is written in, measured, so the
 * embedding model is picked from the text rather than from a default.
 *
 * WHY. The default model is `all-minilm`, which is English-only: bench/ measured it at
 * MRR 0.006 on Thai paraphrase queries, and cos(en, th-translation) at +0.187. If a
 * tenth of the corpus carries Thai, a tenth of it embeds as noise and nothing says so.
 * "Which model" is a question about the corpus, and the corpus can answer it.
 *
 * SCRIPT, NOT A LANGUAGE DETECTOR. Thai against Latin is a Unicode-block question and
 * needs no model. What script counting cannot do is tell English from another
 * Latin-script language, so Latin text is split by whether it carries English function
 * words: `en` is prose, `latin` is code, paths, JSON and identifiers (or another Latin
 * language). For choosing an embedding model, that is the split that matters.
 *
 * SAME POPULATION AS `embed`. Main tiers unless --all-tiers, events of at least
 * --min-chars, and only the first --max-chars of each — the slice embed actually sends.
 * A mix measured over anything else would describe text no model is ever fed.
 */

export interface Scripts {
  thai: number; latin: number; cjk: number; hangul: number; cyrillic: number;
  arabic: number; indic: number; sea: number; other: number;
}

const zero = (): Scripts =>
  ({ thai: 0, latin: 0, cjk: 0, hangul: 0, cyrillic: 0, arabic: 0, indic: 0, sea: 0, other: 0 });
const LETTER = /\p{L}/u;

/** Letters per script. Digits, punctuation, whitespace and emoji count as nothing. */
export function scriptsOf(text: string): Scripts {
  const s = zero();
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) { const l = c | 0x20; if (l >= 0x61 && l <= 0x7a) s.latin++; continue; }
    if (c >= 0x0e00 && c <= 0x0e7f) { s.thai++; continue; }
    if ((c >= 0xc0 && c <= 0x24f && c !== 0xd7 && c !== 0xf7) || (c >= 0x1e00 && c <= 0x1eff)) { s.latin++; continue; }
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff)) { s.cjk++; continue; }
    if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) { s.hangul++; continue; }
    if (c >= 0x0400 && c <= 0x04ff) { s.cyrillic++; continue; }
    if ((c >= 0x0600 && c <= 0x06ff) || (c >= 0x0750 && c <= 0x077f)) { s.arabic++; continue; }
    if (c >= 0x0900 && c <= 0x0dff) { s.indic++; continue; }                        // Devanagari .. Sinhala
    if ((c >= 0x0e80 && c <= 0x0eff) || (c >= 0x1000 && c <= 0x109f) || (c >= 0x1780 && c <= 0x17ff)) { s.sea++; continue; }
    if (c >= 0xd800 && c <= 0xdfff) continue;                                        // surrogate halves: emoji, rare Han
    if (LETTER.test(text[i])) s.other++;
  }
  return s;
}

export type Lang = "th" | "th+en" | "en" | "latin" | "zh/ja" | "ko" | "cyrillic" | "arabic" |
                   "indic" | "lo/km/my" | "other" | "none";

export const LANG_ORDER: Lang[] =
  ["th", "th+en", "en", "latin", "zh/ja", "ko", "cyrillic", "arabic", "indic", "lo/km/my", "other", "none"];

export const LANG_NOTE: Record<Lang, string> = {
  "th": "Thai is at least half the letters",
  "th+en": "Thai is 10-49% of the letters: code-switched, usually with English",
  "en": "Latin script with English function words: prose",
  "latin": "Latin script without them: code, paths, JSON, ids, or another Latin language",
  "zh/ja": "Han, hiragana or katakana dominate",
  "ko": "Hangul dominates",
  "cyrillic": "Cyrillic dominates",
  "arabic": "Arabic script dominates",
  "indic": "an Indic script dominates",
  "lo/km/my": "Lao, Khmer or Myanmar dominates",
  "other": "no single script holds half the letters",
  "none": "no letters at all: numbers, symbols, whitespace",
};

const EN_WORDS = new Set((
  "the and to of in is it that for on with this be are was as not you we can if or " +
  "but have at by from so what do an will my your no should would there which when how " +
  "about all just they them it's don't i'm you're").split(" "));

/**
 * Does Latin text read as English prose? Prose runs ~40% function words; code and JSON
 * run near zero even when every identifier is an English word, so a low bar separates
 * them. Short texts cannot show a rate, so one function word is enough there.
 *
 * Single letters are not words here. `a` and `i` are the commonest function words in
 * prose and the commonest variable names in code: counted, `const a = b` read as English.
 */
export function englishProse(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z]{2,}(?:'[a-z]+)?/g);
  if (!words) return false;
  let hits = 0;
  for (const w of words) if (EN_WORDS.has(w)) hits++;
  return words.length <= 8 ? hits >= 1 : hits >= 2 && hits / words.length >= 0.08;
}

export function langOf(text: string, sc: Scripts = scriptsOf(text)): Lang {
  const total = sc.thai + sc.latin + sc.cjk + sc.hangul + sc.cyrillic + sc.arabic + sc.indic + sc.sea + sc.other;
  if (!total) return "none";
  if (sc.thai * 2 >= total) return "th";
  if (sc.thai * 10 >= total) return "th+en";
  const rest: [Lang, number][] = [["latin", sc.latin], ["zh/ja", sc.cjk], ["ko", sc.hangul],
    ["cyrillic", sc.cyrillic], ["arabic", sc.arabic], ["indic", sc.indic], ["lo/km/my", sc.sea], ["other", sc.other]];
  let [top, n] = rest[0];
  for (const [k, v] of rest) if (v > n) { top = k; n = v; }
  if (n * 2 < total) return "other";
  return top === "latin" ? (englishProse(text) ? "en" : "latin") : top;
}

/**
 * 1-in-N by uid. Every shape builds its uid with uidOf, a sha1 in hex, so a range on the
 * first four hex digits is a UNIFORM and DETERMINISTIC sample: the same N picks the same
 * events on every run, and the filter is pushed into Lance instead of reading text that
 * would be thrown away. `rate` is the exact fraction, for scaling counts back up.
 */
export function sampleWhere(n: number): { where: string; rate: number } {
  if (!(n > 1)) return { where: "", rate: 1 };
  const cut = Math.max(1, Math.min(0xffff, Math.floor(0x10000 / n)));
  return { where: `uid < '${cut.toString(16).padStart(4, "0")}'`, rate: cut / 0x10000 };
}

export interface LangsOpts extends Scope {
  sample?: number;          // 1-in-N; 1 reads every eligible event
  mainTiers?: boolean;
  minChars?: number;
  maxChars?: number;
  /** The CLI flags that set this scope, echoed into every printed embed command. */
  scopeArgs?: string[];
  onProgress?: (done: number, total: number, key: string) => void;
}

export interface VectorsOnDisk { model: string; dim: number; rows: number; shards: number; keys: string[] }

export interface LangsResult {
  shards: number;           // shards in scope
  read: number;             // shards actually read
  failed: string[];
  sample: number; rate: number;
  mainTiers: boolean; minChars: number; maxChars: number;
  events: number;           // sampled events classified
  estimated: number;        // events / rate: the eligible population, scaled back up
  byLang: Partial<Record<Lang, { events: number; chars: number }>>;
  anyThai: number;          // events holding at least one Thai character (bench/'s definition)
  byRole: Record<string, { events: number; thai: number }>;
  scripts: Scripts;         // letters, summed over every sampled slice
  vectors: VectorsOnDisk[];
  scopeArgs: string[];
  ms: number;
}

export function emptyLangs(o: { sample?: number; mainTiers?: boolean; minChars?: number; maxChars?: number; scopeArgs?: string[] } = {}): LangsResult {
  const sample = o.sample ?? 64;
  return {
    shards: 0, read: 0, failed: [], sample, rate: sampleWhere(sample).rate,
    mainTiers: o.mainTiers ?? true, minChars: o.minChars ?? 24, maxChars: o.maxChars ?? 2000,
    events: 0, estimated: 0, byLang: {}, anyThai: 0, byRole: {}, scripts: zero(), vectors: [],
    scopeArgs: o.scopeArgs ?? [], ms: 0,
  };
}

/** Classify one event's embedded slice into the running totals. */
export function tallyLang(r: LangsResult, role: string, text: string): void {
  const sc = scriptsOf(text);
  const lang = langOf(text, sc);
  r.events++;
  const l = (r.byLang[lang] ??= { events: 0, chars: 0 });
  l.events++; l.chars += text.length;
  const ro = (r.byRole[role || "?"] ??= { events: 0, thai: 0 });
  ro.events++;
  if (sc.thai > 0) { r.anyThai++; ro.thai++; }
  for (const k of Object.keys(sc) as (keyof Scripts)[]) r.scripts[k] += sc[k];
}

export async function scanLangs(o: LangsOpts = {}): Promise<LangsResult> {
  const t0 = Date.now();
  const r = emptyLangs(o);
  const { where } = sampleWhere(r.sample);
  const shards = pickShards(o);
  r.shards = shards.length;
  const vec = new Map<string, VectorsOnDisk>();
  for (let i = 0; i < shards.length; i++) {
    const sh = shards[i];
    o.onProgress?.(i + 1, shards.length, sh.key);
    try {
      const store = await LanceStore.open(sh.dir);
      const rows = await store.langRows({ where, mainTiers: r.mainTiers, minChars: r.minChars, maxChars: r.maxChars });
      for (const row of rows) tallyLang(r, row.role, row.text);
      const v = await store.vectorStats();
      if (v && v.rows > 0) {
        const k = `${v.model}|${v.dim}`;
        const agg = vec.get(k) ?? { model: v.model, dim: v.dim, rows: 0, shards: 0, keys: [] };
        agg.rows += v.rows; agg.shards++; agg.keys.push(sh.key);
        vec.set(k, agg);
      }
      r.read++;
    } catch (err) {
      r.failed.push(`${sh.key}: ${String(err).slice(0, 120)}`);
    }
  }
  r.estimated = Math.round(r.events / r.rate);
  r.vectors = [...vec.values()].sort((a, b) => b.shards - a.shards || b.rows - a.rows);
  r.ms = Date.now() - t0;
  return r;
}

// ------------------------------------------------------------------ recommendation

/**
 * The share of eligible events in a script the model must understand, above which an
 * English-only model is the wrong choice. One percent is deliberately low: below it
 * the cost is a handful of unfindable events; above it, it is a slice of the corpus
 * that vector search silently cannot reach.
 */
export const MULTILINGUAL_AT = 0.01;

export interface Candidate extends MeasuredModel { gib: number }

/**
 * How a model already on disk relates to this corpus. `unmeasured` is not a verdict:
 * a model relic has no numbers for is not therefore English-only, and calling it that
 * would advise a --reset nobody can justify.
 */
export type Fit = "fits" | "english-only" | "unmeasured";

export interface OnDisk { model: string; dim: number; fit: Fit; shards: number; keys: string[] }

export interface Recommendation {
  verdict: "multilingual" | "english";
  thaiShare: number;        // anyThai / events
  otherShare: number;       // events whose dominant script is neither Latin nor Thai
  reason: string;
  current: OnDisk[];        // most shards first
  kept: OnDisk | null;      // the fitting model most shards hold
  odd: OnDisk[];            // every other model on disk, named where it sits
  /**
   * The vectors already on disk fit the corpus, so the advice is to keep that model.
   * Switching is not free: embed refuses a second model in a shard (--reset drops the
   * vectors), and semantic search embeds each query with the model its shard stores —
   * so one model across shards is worth more than a better score on one smoke test.
   */
  keep: boolean;
  candidates: Candidate[];
  command: string;          // carries the scope the corpus was measured in
}

const NOT_OTHER = new Set<string>(["th", "th+en", "en", "latin", "none"]);

const idOf = (m: MeasuredModel) => `${m.provider}:${m.model}`;

/** Stored ids carry extras the table does not: st's `+passage:` prefix, Ollama's default `:latest` tag. */
export const baseId = (stored: string) => stored.replace(/\+.*$/, "").replace(/^(ollama:[^:]+):latest$/, "$1");

const quote = (a: string) => /^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`;
const withScope = (cmd: string, scope: string[]) => cmd && scope.length ? `${cmd} ${scope.map(quote).join(" ")}` : cmd;

/** `st:intfloat/multilingual-e5-small+passage:` -> the embed command that continues it. */
export function embedCommandFor(storedId: string): string {
  const m = /^(ollama|st):([^+]+)/.exec(baseId(storedId));
  if (!m) return "";
  return m[1] === "ollama" ? `relic embed --model ${m[2]}` : `relic embed --provider st --model ${m[2]}`;
}

export function recommend(r: LangsResult, models: MeasuredModel[] = MEASURED_MODELS): Recommendation {
  const n = Math.max(1, r.events);
  const thaiShare = r.anyThai / n;
  const otherShare = Object.entries(r.byLang)
    .filter(([k]) => !NOT_OTHER.has(k)).reduce((s, [, v]) => s + (v?.events ?? 0), 0) / n;
  const multi = r.events > 0 && (thaiShare >= MULTILINGUAL_AT || otherShare >= MULTILINGUAL_AT);
  const gib = (dim: number) => (r.estimated * dim * 4) / 2 ** 30;

  // Ollama first — it is embed's default provider and needs no Python. Within a provider,
  // rank by the evidence that provider has: the en-th smoke test for Ollama, the bench/
  // Thai paraphrase MRR for sentence-transformers. The two are NOT comparable, so they
  // are never ranked against each other. On an English corpus, fewest dims first.
  const candidates = models
    .filter(m => !multi || m.multilingual)
    .map(m => ({ ...m, gib: gib(m.dim) }))
    .sort(multi
      ? (a, b) => (a.provider === b.provider
          ? (a.provider === "ollama" ? (b.enTh ?? 0) - (a.enTh ?? 0)
                                     : (b.paraphrase?.th ?? 0) - (a.paraphrase?.th ?? 0))
          : a.provider === "ollama" ? -1 : 1)
      : (a, b) => a.dim - b.dim || (a.provider === b.provider ? 0 : a.provider === "ollama" ? -1 : 1));

  const current: OnDisk[] = r.vectors.map(v => {
    const m = models.find(x => baseId(v.model) === idOf(x));
    const fit: Fit = !m ? "unmeasured" : !multi || m.multilingual ? "fits" : "english-only";
    return { model: v.model, dim: v.dim, fit, shards: v.shards, keys: v.keys };
  });

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const others = otherShare >= 0.001 ? `, ${pct(otherShare)} another non-Latin script` : "";
  const reason = !r.events
    ? "nothing eligible in scope"
    : multi
      ? `${pct(thaiShare)} of eligible events carry Thai${others}, at or above ${pct(MULTILINGUAL_AT)}. ` +
        `An English-only model embeds them as noise (all-minilm: Thai paraphrase MRR 0.006, bench/).`
      : `${pct(thaiShare)} Thai${others || ", no other non-Latin script"}, below ${pct(MULTILINGUAL_AT)}. ` +
        `An English model is enough, and fewer dims cost less.`;

  // Keep the fitting model most shards hold, and name everything else where it sits. A
  // continue command never needs --reset: embed skips a shard that holds another model
  // (with the reason), so it only fills gaps. A --reset is advised ONLY when nothing on
  // disk fits, and even then it carries the measured scope, never the whole index.
  const kept = r.events ? current.find(c => c.fit === "fits") ?? null : null;
  const odd = kept ? current.filter(c => c !== kept) : [];
  const top = candidates[0];
  const unmeasured = current.some(c => c.fit === "unmeasured");
  const command = !r.events ? ""
    : kept ? withScope(embedCommandFor(kept.model), r.scopeArgs)
    : unmeasured || !top ? ""                   // measure it before replacing it
    : withScope((top.provider === "ollama" ? `relic embed --model ${top.model}` : `relic embed --provider st --model ${top.model}`) +
                (current.length ? " --reset" : ""), r.scopeArgs);

  return { verdict: multi ? "multilingual" : "english", thaiShare, otherShare, reason, current,
           kept, odd, keep: Boolean(kept), candidates, command };
}

// ------------------------------------------------------------------------- render

const num = (n: number) => n.toLocaleString("en-US");
const pc = (x: number) => `${(x * 100).toFixed(1)}%`;

function evidence(m: MeasuredModel): string {
  if (m.paraphrase) return `MRR ${m.knownItem?.all.toFixed(3) ?? "-"} · Thai paraphrase ${m.paraphrase.th.toFixed(3)}`;
  if (m.enTh !== undefined) return `cos en-th +${m.enTh.toFixed(3)} (smoke test, no ranking bench yet)`;
  return "";
}

export function renderLangs(r: LangsResult, rec: Recommendation): string {
  const out: string[] = [];
  const tiers = r.mainTiers ? "main tiers" : "all tiers";
  out.push(`scope    ${num(r.read)}/${num(r.shards)} shards · ${tiers} · events >= ${r.minChars} chars, ` +
           `first ${num(r.maxChars)} chars of each (the slice embed sends)`);
  // The cut is floored to whole hex steps, so print the rate actually sampled, not the N asked.
  out.push(`sample   ${r.rate < 1 ? `1 in ${num(Math.round(1 / r.rate))} by uid` : "every event"} -> ${num(r.events)} events` +
           (r.rate < 1 ? ` · ~${num(r.estimated)} eligible` : "") + ` · ${(r.ms / 1000).toFixed(1)} s`);
  if (r.failed.length) out.push(`failed   ${r.failed.length} shards unreadable, first: ${r.failed[0]}`);
  if (!r.events) {
    out.push("", "nothing eligible in scope: no event passes the filter. " +
             (r.mainTiers ? "A memory or subagent bank is all non-main kinds, try --all-tiers." : ""));
    return out.join("\n");
  }

  const chars = Object.values(r.byLang).reduce((s, v) => s + (v?.chars ?? 0), 0) || 1;
  out.push("", "lang        events   share   chars   what it is");
  for (const k of LANG_ORDER) {
    const v = r.byLang[k];
    if (!v) continue;
    out.push(`${k.padEnd(9)} ${num(v.events).padStart(8)}  ${pc(v.events / r.events).padStart(6)}  ` +
             `${pc(v.chars / chars).padStart(6)}   ${LANG_NOTE[k]}`);
  }
  out.push(`${"any Thai".padEnd(9)} ${num(r.anyThai).padStart(8)}  ${pc(r.anyThai / r.events).padStart(6)}  ` +
           `${"".padStart(6)}   at least one Thai character (bench/'s definition)`);

  out.push("", "role            events   carry Thai");
  for (const [role, v] of Object.entries(r.byRole).sort((a, b) => b[1].events - a[1].events))
    out.push(`${role.padEnd(12)} ${num(v.events).padStart(9)}   ${pc(v.thai / v.events).padStart(6)}`);

  const letters = Object.values(r.scripts).reduce((s, v) => s + v, 0) || 1;
  const shown = Object.entries(r.scripts).filter(([, v]) => v / letters >= 0.001).sort((a, b) => b[1] - a[1]);
  const rest = Object.entries(r.scripts).filter(([, v]) => v > 0 && v / letters < 0.001).map(([k]) => k);
  out.push("", "letters  " + shown.map(([k, v]) => `${k} ${pc(v / letters)}`).join(" · ") +
           (rest.length ? ` · under 0.1%: ${rest.join(", ")}` : ""));

  out.push("");
  if (!r.vectors.length) out.push("vectors  none on disk in this scope: relic embed has not run here");
  const FIT_NOTE: Record<Fit, string> = {
    "fits": "", "english-only": "   <- English-only for this corpus",
    "unmeasured": "   <- not measured here: MEASURED_MODELS has no numbers for it",
  };
  for (const [i, v] of r.vectors.entries())
    out.push(`vectors  ${v.model} · ${v.dim}d · ${num(v.rows)} rows in ${num(v.shards)} shards` +
             FIT_NOTE[rec.current[i]?.fit ?? "fits"]);

  out.push("", `model    ${rec.verdict === "multilingual" ? "MULTILINGUAL" : "ENGLISH is enough"}. ${rec.reason}`);
  // Two sentence-transformers ids run past 50 chars; padding every row to them would
  // push the numbers off an 80-column terminal, so the name column stops at 30.
  const w = Math.min(30, Math.max(...rec.candidates.map(c => c.model.length)));
  for (const c of rec.candidates)
    out.push(`         ${c.provider.padEnd(6)} ${String(c.dim).padStart(4)}d  ${`~${c.gib.toFixed(1)}`.padStart(6)} GiB  ` +
             `${c.model.padEnd(w)}  ${evidence(c)}`);
  const where = (o: OnDisk) => `${o.keys.slice(0, 3).join(", ")}${o.keys.length > 3 ? ", ..." : ""}`;
  if (rec.kept) {
    out.push(`         -> keep the model on disk (${rec.kept.model}, ${num(rec.kept.shards)} shards). It already covers ` +
             `this mix, and one model across shards keeps semantic search comparable. Continue with: ${rec.command}`);
    // Each shard answers semantic search with its own model, so scores across models are
    // not on one scale. Name the odd shards; never widen a --reset to the ones that fit.
    for (const o of rec.odd)
      out.push(`            ${o.model} is on ${num(o.shards)} other shards (${where(o)}): ` +
               (o.fit === "english-only" ? "English-only for this corpus. Re-embed those shards with the kept model; embed refuses a second model per shard, so they need --reset, scoped to them."
                : o.fit === "unmeasured" ? "not measured here. Bench it before trusting it on Thai, or re-embed those shards with the kept model."
                : "it fits too, but a second model splits the score scale. Re-embed those shards with the kept model and --reset, scoped to them."));
  }
  else if (rec.current.some(c => c.fit === "unmeasured"))
    out.push("         -> the vectors on disk come from a model relic has not measured. Measure it (bench/) before " +
             "replacing it; if it loses, embed with a candidate above.");
  else if (rec.command)
    out.push(`         -> ${rec.command}` +
             (rec.current.length ? "   (nothing on disk fits; --reset drops those vectors in the scope shown)" : ""));
  out.push("         GiB = eligible events x dim x 4 bytes. FTS still beats every model on known-item " +
           "(MRR 0.890 vs 0.600, bench/); vectors earn their place on paraphrase queries.");
  return out.join("\n");
}
