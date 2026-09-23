"""Which languages the embeddable corpus is written in — the half of src/langs.ts that
`embed` needs to check a model against the scope it is about to embed.

There is no `relic-py langs` verb yet; this is the measurement and the rule, ported so
`relic-py embed` refuses the same English-only model on the same Thai scope as
`relic embed`. Every classification here must agree with the TypeScript one, and
test_embed.py runs both over one shard to prove it.

SCRIPT, NOT A LANGUAGE DETECTOR. Thai against Latin is a Unicode-block question and
needs no model. Latin text is split by English function words: `en` is prose, `latin`
is code, paths, JSON and ids. For choosing an embedding model, that is the split that
matters.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Callable, Optional

from .models import Scope
from .query import pick_shards
from .store import LanceStore

# ------------------------------------------------------------------- the models


@dataclass
class MeasuredModel:
    provider: str                       # "ollama" | "st"
    model: str                          # exactly what --model takes
    dim: int
    multilingual: bool                  # marked "multi" when measured — unmarked is NOT a claim
    en_th: Optional[float] = None       # cos(en, th-translation): a smoke test, not a benchmark
    known_item: Optional[dict] = None   # MRR@20 {all, th}, bench/README.md
    paraphrase: Optional[dict] = None   # MRR@20 {all, th}, bench/README.md

    def to_json(self) -> dict:
        """The keys src/embed.ts writes, so both front ends print one JSON shape."""
        d = {"provider": self.provider, "model": self.model, "dim": self.dim,
             "multilingual": self.multilingual}
        if self.en_th is not None:
            d["enTh"] = self.en_th
        if self.known_item is not None:
            d["knownItem"] = self.known_item
        if self.paraphrase is not None:
            d["paraphrase"] = self.paraphrase
        return d


# MEASURED_MODELS in src/embed.ts, row for row — test_embed.py compares the two tables.
# It lives here, not in embed.py, because embed.py imports this module.
MEASURED_MODELS: list[MeasuredModel] = [
    MeasuredModel("ollama", "all-minilm", 384, False, en_th=0.187),
    MeasuredModel("ollama", "nomic-embed-text", 768, False, en_th=0.467),
    MeasuredModel("ollama", "mxbai-embed-large", 1024, False, en_th=0.479),
    MeasuredModel("ollama", "qwen3-embedding:0.6b", 1024, True, en_th=0.572),
    MeasuredModel("ollama", "bge-m3", 1024, True, en_th=0.626),
    MeasuredModel("st", "intfloat/multilingual-e5-small", 384, True,
                  known_item={"all": 0.600, "th": 0.308}, paraphrase={"all": 0.140, "th": 0.214}),
    MeasuredModel("st", "sentence-transformers/all-MiniLM-L6-v2", 384, False,
                  known_item={"all": 0.503, "th": 0.209}, paraphrase={"all": 0.119, "th": 0.006}),
    MeasuredModel("st", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2", 384, True,
                  known_item={"all": 0.430, "th": 0.203}, paraphrase={"all": 0.081, "th": 0.078}),
]

# ------------------------------------------------------------------ classification

SCRIPTS = ("thai", "latin", "cjk", "hangul", "cyrillic", "arabic", "indic", "sea", "other")


def scripts_of(text: str) -> dict[str, int]:
    """Letters per script. Digits, punctuation, whitespace and emoji count as nothing.

    TypeScript walks UTF-16 code units and skips surrogate halves, so a character past
    U+FFFF counts as nothing there. Skipping those code points here is the same rule.
    """
    s = dict.fromkeys(SCRIPTS, 0)
    for ch in text:
        c = ord(ch)
        if c < 0x80:
            if 0x61 <= (c | 0x20) <= 0x7a:
                s["latin"] += 1
        elif 0x0e00 <= c <= 0x0e7f:
            s["thai"] += 1
        elif (0xc0 <= c <= 0x24f and c not in (0xd7, 0xf7)) or 0x1e00 <= c <= 0x1eff:
            s["latin"] += 1
        elif 0x4e00 <= c <= 0x9fff or 0x3400 <= c <= 0x4dbf or 0x3040 <= c <= 0x30ff:
            s["cjk"] += 1
        elif 0xac00 <= c <= 0xd7af or 0x1100 <= c <= 0x11ff or 0x3130 <= c <= 0x318f:
            s["hangul"] += 1
        elif 0x0400 <= c <= 0x04ff:
            s["cyrillic"] += 1
        elif 0x0600 <= c <= 0x06ff or 0x0750 <= c <= 0x077f:
            s["arabic"] += 1
        elif 0x0900 <= c <= 0x0dff:                                     # Devanagari .. Sinhala
            s["indic"] += 1
        elif 0x0e80 <= c <= 0x0eff or 0x1000 <= c <= 0x109f or 0x1780 <= c <= 0x17ff:
            s["sea"] += 1
        elif c > 0xffff:
            continue
        elif ch.isalpha():
            s["other"] += 1
    return s


EN_WORDS = set((
    "the and to of in is it that for on with this be are was as not you we can if or "
    "but have at by from so what do an will my your no should would there which when how "
    "about all just they them it's don't i'm you're").split())
_WORD = re.compile(r"[a-z]{2,}(?:'[a-z]+)?")


def english_prose(text: str) -> bool:
    """Prose runs ~40% function words; code and JSON run near zero. Single letters are
    not words: `a` is the commonest function word AND the commonest variable name."""
    words = _WORD.findall(text.lower())
    if not words:
        return False
    hits = sum(1 for w in words if w in EN_WORDS)
    return hits >= 1 if len(words) <= 8 else hits >= 2 and hits / len(words) >= 0.08


def lang_of(text: str, sc: Optional[dict[str, int]] = None) -> str:
    sc = sc or scripts_of(text)
    total = sum(sc.values())
    if not total:
        return "none"
    if sc["thai"] * 2 >= total:
        return "th"
    if sc["thai"] * 10 >= total:
        return "th+en"
    rest = [("latin", sc["latin"]), ("zh/ja", sc["cjk"]), ("ko", sc["hangul"]),
            ("cyrillic", sc["cyrillic"]), ("arabic", sc["arabic"]), ("indic", sc["indic"]),
            ("lo/km/my", sc["sea"]), ("other", sc["other"])]
    top, n = rest[0]
    for k, v in rest:
        if v > n:
            top, n = k, v
    if n * 2 < total:
        return "other"
    return ("en" if english_prose(text) else "latin") if top == "latin" else top


def sample_where(n: int) -> tuple[str, float]:
    """1 in N by uid. A uid is a sha1 in hex, so a range on its first four digits is a
    uniform, repeatable sample, and the filter runs inside Lance."""
    if not n > 1:
        return "", 1.0
    cut = max(1, min(0xffff, 0x10000 // n))
    return f"uid < '{cut:04x}'", cut / 0x10000


# ------------------------------------------------------------------------ the scan


@dataclass
class VectorsOnDisk:
    model: str
    dim: int
    rows: int = 0
    shards: int = 0
    keys: list[str] = field(default_factory=list)


@dataclass
class LangsResult:
    shards: int = 0
    read: int = 0
    failed: list[str] = field(default_factory=list)
    rate: float = 1.0
    events: int = 0
    estimated: int = 0
    by_lang: dict[str, int] = field(default_factory=dict)   # events per lang
    any_thai: int = 0
    vectors: list[VectorsOnDisk] = field(default_factory=list)
    scope_args: list[str] = field(default_factory=list)
    ms: int = 0


def tally_lang(r: LangsResult, text: str) -> None:
    sc = scripts_of(text)
    lang = lang_of(text, sc)
    r.events += 1
    r.by_lang[lang] = r.by_lang.get(lang, 0) + 1
    if sc["thai"] > 0:
        r.any_thai += 1


def scan_langs(s: Scope, *, sample: int = 64, main_tiers: bool = True, min_chars: int = 24,
               max_chars: int = 2000, scope_args: Optional[list[str]] = None,
               on_progress: Optional[Callable[[int, int, str], None]] = None) -> LangsResult:
    """The population embed would feed a model, sampled 1 in `sample` by uid."""
    t0 = time.time()
    where, rate = sample_where(sample)
    r = LangsResult(rate=rate, scope_args=list(scope_args or []))
    shards = pick_shards(s)
    r.shards = len(shards)
    vec: dict[str, VectorsOnDisk] = {}
    for i, sh in enumerate(shards):
        if on_progress:
            on_progress(i + 1, len(shards), sh.key)
        try:
            store = LanceStore.open(sh.dir)
            for row in store.lang_rows(where=where, main_tiers=main_tiers, min_chars=min_chars,
                                       max_chars=max_chars):
                tally_lang(r, row["text"])
            v = store.vector_stats()
            if v and v["rows"] > 0:
                agg = vec.setdefault(f"{v['model']}|{v['dim']}", VectorsOnDisk(v["model"], v["dim"]))
                agg.rows += v["rows"]
                agg.shards += 1
                agg.keys.append(sh.key)
            r.read += 1
        except Exception as e:
            r.failed.append(f"{sh.key}: {str(e)[:120]}")
    # round() is half-even and Math.round is half-up; floor(x + 0.5) is the TypeScript one.
    r.estimated = int(r.events / r.rate + 0.5)
    r.vectors = sorted(vec.values(), key=lambda v: (-v.shards, -v.rows))
    r.ms = int((time.time() - t0) * 1000)
    return r


# ------------------------------------------------------------------ recommendation

# At least this share of eligible events in a script the model must understand, and an
# English-only model is the wrong choice. Deliberately low — see src/langs.ts.
MULTILINGUAL_AT = 0.01
NOT_OTHER = {"th", "th+en", "en", "latin", "none"}


def _fixed(x: float, digits: int) -> str:
    """Number.prototype.toFixed: the exact binary value, a tie rounds up. Python's format
    rounds a tie to even, so 12.25 would print 12.2 here and 12.3 in TypeScript."""
    return str(Decimal(x).quantize(Decimal(1).scaleb(-digits), rounding=ROUND_HALF_UP))


def _pct(x: float) -> str:
    return f"{_fixed(x * 100, 1)}%"


def base_id(stored: str) -> str:
    """Stored ids carry extras the table does not: st's `+passage:`, Ollama's `:latest`."""
    return re.sub(r"^(ollama:[^:]+):latest$", r"\1", re.sub(r"\+.*$", "", stored))


def fit_of(model_id: str, multilingual: bool, models: Optional[list[MeasuredModel]] = None) -> str:
    """fits | english-only | unmeasured — `unmeasured` is not a verdict: no numbers is not
    "English-only"."""
    m = next((x for x in (MEASURED_MODELS if models is None else models)
              if base_id(model_id) == f"{x.provider}:{x.model}"), None)
    if m is None:
        return "unmeasured"
    return "fits" if not multilingual or m.multilingual else "english-only"


def _quote(a: str) -> str:
    # [A-Za-z0-9_], not \w: Python's \w matches Thai letters, JavaScript's does not.
    return a if re.fullmatch(r"[A-Za-z0-9_@%+=:,./-]+", a) else "'" + a.replace("'", "'\\''") + "'"


def with_scope(cmd: str, scope: list[str]) -> str:
    return f"{cmd} {' '.join(_quote(a) for a in scope)}" if cmd and scope else cmd


def embed_command_for(stored_id: str) -> str:
    m = re.match(r"^(ollama|st):([^+]+)", base_id(stored_id))
    if not m:
        return ""
    return (f"relic embed --model {m[2]}" if m[1] == "ollama"
            else f"relic embed --provider st --model {m[2]}")


@dataclass
class Candidate:
    m: MeasuredModel
    gib: float

    def to_json(self) -> dict:
        return {**self.m.to_json(), "gib": self.gib}


@dataclass
class Recommendation:
    verdict: str
    thai_share: float
    other_share: float
    reason: str
    current: list[dict]              # {model, dim, fit, shards, keys}, most shards first
    kept: Optional[dict]
    candidates: list[Candidate]
    command: str


def recommend(r: LangsResult, models: Optional[list[MeasuredModel]] = None) -> Recommendation:
    """src/langs.ts recommend(), rule for rule. Ollama candidates rank by their en-th smoke
    test, sentence-transformers ones by bench/'s Thai paraphrase MRR, and the two are never
    ranked against each other."""
    models = MEASURED_MODELS if models is None else models
    n = max(1, r.events)
    thai = r.any_thai / n
    other = sum(v for k, v in r.by_lang.items() if k not in NOT_OTHER) / n
    multi = r.events > 0 and (thai >= MULTILINGUAL_AT or other >= MULTILINGUAL_AT)
    cands = [Candidate(m, r.estimated * m.dim * 4 / 2 ** 30)
             for m in models if not multi or m.multilingual]
    if multi:
        cands.sort(key=lambda c: (c.m.provider != "ollama",
                                  -(c.m.en_th or 0) if c.m.provider == "ollama"
                                  else -((c.m.paraphrase or {}).get("th") or 0)))
    else:
        cands.sort(key=lambda c: (c.m.dim, c.m.provider != "ollama"))

    current = [{"model": v.model, "dim": v.dim, "fit": fit_of(v.model, multi, models),
                "shards": v.shards, "keys": v.keys} for v in r.vectors]
    others = f", {_pct(other)} another non-Latin script" if other >= 0.001 else ""
    if not r.events:
        reason = "nothing eligible in scope"
    elif multi:
        reason = (f"{_pct(thai)} of eligible events carry Thai{others}, at or above "
                  f"{_pct(MULTILINGUAL_AT)}. An English-only model embeds them as noise "
                  f"(all-minilm: Thai paraphrase MRR 0.006, bench/).")
    else:
        reason = (f"{_pct(thai)} Thai{others or ', no other non-Latin script'}, below "
                  f"{_pct(MULTILINGUAL_AT)}. An English model is enough, and fewer dims cost less.")

    kept = next((c for c in current if c["fit"] == "fits"), None) if r.events else None
    top = cands[0].m if cands else None
    if not r.events:
        command = ""
    elif kept:
        command = with_scope(embed_command_for(kept["model"]), r.scope_args)
    elif any(c["fit"] == "unmeasured" for c in current) or not top:
        command = ""                                   # measure it before replacing it
    else:
        cmd = (f"relic embed --model {top.model}" if top.provider == "ollama"
               else f"relic embed --provider st --model {top.model}")
        command = with_scope(cmd + (" --reset" if current else ""), r.scope_args)
    return Recommendation("multilingual" if multi else "english", thai, other, reason,
                          current, kept, cands, command)


# ----------------------------------------------------------------- the embed check

# Below this many sampled events the check reads every event: see src/langs.ts.
CHECK_MIN_EVENTS = 1_000


@dataclass
class EmbedCheck:
    model: str
    fit: str
    action: str                      # pass | note | refuse | forced
    verdict: str
    thai_share: float
    other_share: float
    reason: str
    events: int
    estimated: int
    rate: float
    shards: int
    candidates: list[Candidate]
    command: str
    kept: Optional[str]
    on_disk: list[str]
    langs_command: str
    ms: int

    def to_json(self) -> dict:
        """The keys of EmbedCheck in src/langs.ts."""
        return {"model": self.model, "fit": self.fit, "action": self.action,
                "verdict": self.verdict, "thaiShare": self.thai_share,
                "otherShare": self.other_share, "reason": self.reason,
                "events": self.events, "estimated": self.estimated, "rate": self.rate,
                "shards": self.shards, "candidates": [c.to_json() for c in self.candidates],
                "command": self.command, "kept": self.kept, "onDisk": self.on_disk,
                "langsCommand": self.langs_command, "ms": self.ms}


def check_embed_model(model_id: str, s: Scope, *, main_tiers: bool = True, min_chars: int = 24,
                      max_chars: int = 2000, scope_args: Optional[list[str]] = None,
                      force: bool = False, sample: int = 64,
                      on_progress: Optional[Callable[[int, int, str], None]] = None) -> EmbedCheck:
    """`embed` measures its scope before any provider call, and stops an English-only
    model on a scope that carries Thai — the rule and the reasons are in src/langs.ts.
    REFUSE, NOT WARN: a warning prints once above a progress bar that runs for hours.

    No `session` here: relic-py embed has no --session, so there is no one-session scope
    to measure.
    """
    t0 = time.time()
    kw = dict(main_tiers=main_tiers, min_chars=min_chars, max_chars=max_chars,
              scope_args=scope_args, on_progress=on_progress)
    r = scan_langs(s, sample=sample, **kw)
    if r.rate < 1 and r.events < CHECK_MIN_EVENTS:
        r = scan_langs(s, sample=1, **kw)
    rec = recommend(r)
    multi = rec.verdict == "multilingual"
    fit = fit_of(model_id, multi)
    action = ("pass" if not multi or fit == "fits" else "note" if fit == "unmeasured"
              else "forced" if force else "refuse")
    return EmbedCheck(model_id, fit, action, rec.verdict, rec.thai_share, rec.other_share,
                      rec.reason, r.events, r.estimated, r.rate, r.shards,
                      rec.candidates if multi else [], rec.command,
                      rec.kept["model"] if rec.kept else None,
                      [c["model"] for c in rec.current], with_scope("relic langs", r.scope_args),
                      int((time.time() - t0) * 1000))


def _evidence(m: MeasuredModel) -> str:
    if m.paraphrase:
        mrr = _fixed(m.known_item["all"], 3) if m.known_item else "-"
        return f"MRR {mrr} · Thai paraphrase {_fixed(m.paraphrase['th'], 3)}"
    if m.en_th is not None:
        return f"cos en-th +{_fixed(m.en_th, 3)} (smoke test, no ranking bench yet)"
    return ""


def _candidate_rows(cands: list[Candidate], indent: str) -> list[str]:
    w = min(30, max((len(c.m.model) for c in cands), default=0))
    return [f"{indent}{c.m.provider:<6} {c.m.dim:>4}d  {'~' + _fixed(c.gib, 1):>6} GiB  "
            f"{c.m.model:<{w}}  {_evidence(c.m)}" for c in cands]


def render_embed_check(c: EmbedCheck, dry_run: bool = False) -> str:
    """What embed prints before any provider call — the same text as src/langs.ts."""
    if c.action == "pass":
        return ""
    sampled = (f"1 in {int(1 / c.rate + 0.5):,} by uid" if c.rate < 1 else "every event") + \
        f" -> {c.events:,} events" + (f" · ~{c.estimated:,} eligible" if c.rate < 1 else "")
    measured = f"measured {sampled} in {c.shards:,} shards · {_fixed(c.ms / 1000, 1)} s"
    if c.action == "note":
        return "\n".join([
            f"  note  {c.model} is not measured here, so nothing says whether it reads this scope's Thai.",
            f"        {c.reason}",
            f"        {measured}",
            f"        The models that are measured, against the whole mix: {c.langs_command}"])
    if c.action == "forced":
        head = f"  ⚠ --force: embedding with {c.model}, which is English-only, into a scope that is not."
    elif dry_run:
        head = f"  ⚠ {c.model} is English-only, and this scope is not. Without --force, a real run stops here."
    else:
        head = f"  ⚠ embed REFUSED — {c.model} is English-only, and this scope is not. Nothing was embedded."
    out = [head, f"    {c.reason}", f"    {measured}"]
    if c.candidates:
        out += ["    multilingual, measured here:", *_candidate_rows(c.candidates, "      ")]
    if c.command:
        note = (f"   ({c.kept} is already on disk here, and fits)" if c.kept
                else "   (nothing on disk fits; --reset drops those vectors in this scope)" if c.on_disk
                else "")
        out.append(f"    -> {c.command}{note}")
    out.append(f"    {f'--force embeds with {c.model} anyway. ' if c.action == 'refuse' else ''}"
               f"The whole mix, by role, and the vectors on disk: {c.langs_command}")
    return "\n".join(out)
