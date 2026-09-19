"""Paraphrase retrieval: the query shares the document's MEANING, not its words.

This is the benchmark the known-item one cannot be. `make_queries.py` lifts a literal
span out of the target, which is precisely the case lexical search is built for — so
its result ("FTS 0.890 vs 0.600") says nothing about the case vectors exist to serve.
Here a local LLM restates each document as a question, under an instruction not to
reuse its distinctive terms, and the retrievers must bridge the vocabulary gap.

PAIRED ON PURPOSE. The target documents are the SAME 200 as `/tmp/queries.json`, read
from that file rather than resampled. Only the query changes, so a difference in MRR
is attributable to query style and not to having drawn easier documents.

THE GENERATOR IS NOT TRUSTED, IT IS MEASURED. An LLM told to paraphrase will still
sometimes echo a rare identifier, and one that does has quietly written a known-item
query wearing a costume. So every query carries a measured `overlap` with its target,
and the report stratifies by it: if the "paraphrase" advantage only appears at high
overlap, the benchmark is measuring the same thing as before.
"""
import json
import os
import random
import re
import sys
import time
import urllib.request

POOL = os.environ.get("BENCH_POOL", "/tmp/pool.json")
KNOWN = os.environ.get("BENCH_QUERIES", "/tmp/queries.json")
OUT = os.environ.get("BENCH_PARA", "/tmp/queries_para.json")
MODEL = os.environ.get("BENCH_GEN_MODEL", "gemma3:27b")
HOST = os.environ.get("OLLAMA_HOST", "http://localhost:11434").rstrip("/")

THAI = re.compile(r"[฀-๿]")
random.seed(97)

# Deliberately short. A long list would suppress real overlap and flatter the
# generator; these are the words whose presence says nothing about topic.
STOP = set("""a an the and or but if then than that this these those of in on at to for
from with without by as is are was were be been being it its it's not no do does did
so such can could should would will shall may might must have has had i you he she we
they them his her their our your my me us who whom which what when where why how all
any some each other more most much many very just only also into over under about
after before while during between because there here how's don't""".split())


def content_words(text: str) -> set[str]:
    ws = re.findall(r"[a-z0-9_./-]{3,}", text.lower())
    return {w for w in ws if w not in STOP}


def char_ngrams(text: str, n: int = 3) -> set[str]:
    s = re.sub(r"\s+", "", text)
    return {s[i:i + n] for i in range(len(s) - n + 1)}


def overlap_of(query: str, doc: str, thai: bool) -> float:
    """Jaccard between query and document.

    Two measures, because one would be wrong for half the corpus: English has word
    boundaries and Thai does not, so Thai is compared on character 3-grams — the same
    reason relic's index needs an ICU tokenizer rather than whitespace.
    """
    a, b = ((char_ngrams(query), char_ngrams(doc)) if thai
            else (content_words(query), content_words(doc)))
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def generate(doc: str, thai: bool, tries: int = 3) -> str:
    lang = "Thai" if thai else "English"
    prompt = (
        f"Read the passage. Write ONE short question (max 18 words) in {lang} that this "
        "passage answers.\nRules: do NOT reuse any distinctive word, identifier, filename, "
        "path or number from the passage. Describe the idea in completely different words. "
        "Output ONLY the question.\n\nPassage:\n" + doc[:1200])
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                f"{HOST}/api/generate",
                data=json.dumps({"model": MODEL, "prompt": prompt, "stream": False,
                                 "think": False,
                                 "options": {"temperature": 0.8, "num_predict": 120,
                                             "seed": 1000 + attempt}}).encode(),
                headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=600) as r:
                out = json.loads(r.read()).get("response", "")
        except Exception:
            time.sleep(1.0)
            continue
        q = " ".join(out.strip().split())
        # Strip the framing a chat model adds even when told not to.
        q = re.sub(r'^(question|คำถาม)\s*[:：]\s*', "", q, flags=re.I).strip('"“” ')
        if 8 <= len(q) <= 200 and "\n" not in q:
            return q
    return ""


def main() -> int:
    pool = {r["uid"]: " ".join(r["text"].split()) for r in json.load(open(POOL))}
    known = json.load(open(KNOWN))
    out, skipped = [], 0
    t0 = time.time()
    for i, k in enumerate(known, 1):
        doc = pool.get(k["uid"])
        if not doc:
            skipped += 1
            continue
        thai = bool(k.get("thai"))
        q = generate(doc, thai)
        if not q:
            skipped += 1
            continue
        out.append({"q": q, "uid": k["uid"], "thai": thai,
                    "overlap": round(overlap_of(q, doc, thai), 4)})
        if i % 25 == 0:
            rate = i / (time.time() - t0)
            print(f"  {i}/{len(known)}  {rate:.2f}/s  eta {int((len(known)-i)/max(rate,1e-9))}s",
                  flush=True)
    json.dump(out, open(OUT, "w"), ensure_ascii=False)

    ov = sorted(x["overlap"] for x in out)
    med = ov[len(ov) // 2] if ov else 0.0
    nth = sum(x["thai"] for x in out)
    print(f"\n  {len(out)} paraphrase queries ({skipped} skipped) — {nth} Thai, {len(out)-nth} not")
    print(f"  model: {MODEL}   median query/doc overlap: {med:.3f}"
          f"   zero-overlap: {sum(1 for x in ov if x == 0)}")
    print(f"  bands:  0  {sum(1 for x in ov if x == 0):3d}"
          f" | 0-0.05  {sum(1 for x in ov if 0 < x <= 0.05):3d}"
          f" | 0.05-0.15  {sum(1 for x in ov if 0.05 < x <= 0.15):3d}"
          f" | >0.15  {sum(1 for x in ov if x > 0.15):3d}")
    for x in out[:2]:
        print(f"  sample ({'th' if x['thai'] else 'en'}, ov={x['overlap']:.3f}): {x['q'][:90]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
