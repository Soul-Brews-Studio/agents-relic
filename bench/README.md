# Retrieval benchmark — is any of this worth shipping?

Known-item retrieval on a shared pool. Every method searches the **same** 3,000
documents, because comparing FTS over 3.4 M events against embeddings over a 3,000-doc
pool would be rigged — a bigger candidate set is strictly harder.

```bash
cd python
uv run python ../bench/build_pool.py      # 3,000 docs, 400 with Thai
uv run python ../bench/make_queries.py    # 200 known-item queries
uv run python ../bench/bench.py           # FTS (ICU) baseline
uv run --with sentence-transformers python ../bench/bench_emb.py
uv run python ../bench/bench_expand.py    # translation query expansion
uv run python ../bench/report.py
```

## Result, 2026-09-18

```
n=200 known-item queries · pool=3,000 docs · MRR@20

method                        MRR    R@1   R@10   miss  MRR th  MRR en  query cost
FTS (ICU)                   0.890  83.0%  96.5%   2.5%   0.768   0.909     1.3 ms
FTS + expand(fr) append     0.890  83.0%  96.5%   2.5%   0.768   0.909     2.9 ms + 480 ms
FTS + expand(fr) RRF        0.822  73.5%  95.0%   3.0%   0.740   0.835     2.9 ms + 480 ms
multilingual-e5-small       0.600  52.5%  74.0%  22.0%   0.308   0.648     0.4 ms
all-MiniLM-L6 (en only)     0.503  42.5%  66.0%  30.5%   0.209   0.551     0.3 ms
multilingual-MiniLM-L12     0.430  36.5%  53.5%  40.0%   0.203   0.467     0.5 ms
```

## What it decided

**Nothing ships.** FTS wins by a wide margin and the alternatives are neutral or worse.

- **Embeddings miss 22–40% of queries entirely** where FTS misses 2.5%.
- **On Thai, lexical beats every vector model ~2.5x** (0.768 vs 0.308). ICU word
  segmentation is doing the work; no 384-dim multilingual model came close.
- **RRF fusion made retrieval WORSE** (0.890 -> 0.822). Independent reproduction of an
  earlier measurement on a different corpus (0.765 -> 0.437). k=60 is the fleet default
  and it is wrong here: fusing a weak list with a strong one drags the strong one down,
  because RRF weights both equally.
- **Expansion with installed pairs is a no-op** — `append` scored IDENTICALLY to
  baseline. Translating an English query to French and searching English content cannot
  find anything new. The mechanism is correct; the application is empty until `th->en`
  is installed.
- **Translation costs 480 ms/query**, 370x the search it augments.

## The caveat, stated because it changes the conclusion

This measures **known-item** retrieval — "find the thing I half-remember" — which is
exactly what lexical search is best at. It does NOT test paraphrase queries, where
embeddings should win and FTS structurally cannot help. Measured elsewhere, vector/FTS
top-10 Jaccard overlap is 0.009-0.018: they find genuinely different things.

So the finding is not "embeddings are bad". It is: **they must never be the default and
must never be RRF-blended.** If they ship, they ship as an explicit `--semantic` mode
with its own benchmark for paraphrase queries.
