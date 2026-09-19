# Retrieval benchmark — is any of this worth shipping?

Known-item retrieval on a shared pool. Every method searches the **same** 3,000
documents, because comparing FTS over 3.4 M events against embeddings over a 3,000-doc
pool would be rigged — a bigger candidate set is strictly harder.

Two query sets over that one pool, because they ask different questions:

| set | query is | what it can show |
|---|---|---|
| **known-item** | a literal 8–12 word span lifted from the target | "find the thing I half-remember" — the case lexical search is built for |
| **paraphrase** | an LLM restatement of the target, told not to reuse its terms | "find the thing I can only describe" — the case vectors exist for |

```bash
cd python
uv run python ../bench/build_pool.py      # 3,000 docs, 400 with Thai
uv run python ../bench/make_queries.py    # 200 known-item queries
uv run python ../bench/bench.py           # FTS (ICU) baseline
uv run --with sentence-transformers python ../bench/bench_emb.py
uv run python ../bench/bench_expand.py    # translation query expansion
uv run python ../bench/report.py

# paraphrase — same pool, SAME 200 target documents, different queries
uv run python ../bench/make_paraphrase.py
BENCH_QUERIES=/tmp/queries_para.json BENCH_FTS=/tmp/bench_fts_para.pkl \
  uv run python ../bench/bench.py
BENCH_QUERIES=/tmp/queries_para.json BENCH_FTS=/tmp/bench_fts_para.pkl \
  BENCH_ALL=/tmp/bench_all_para.pkl \
  uv run --with sentence-transformers python ../bench/bench_emb.py
BENCH_ALL=/tmp/bench_all_para.pkl uv run python ../bench/report_para.py
```

Every path is an env var (`BENCH_POOL`, `BENCH_QUERIES`, `BENCH_FTS`, `BENCH_ALL`,
`BENCH_PARA`) so both runs use the same scripts. A second copy of `bench.py` that
"only differs in the query file" is how two benchmarks quietly stop being comparable.

### Why the paraphrase set is paired, and why the generator is measured

**Paired.** `make_paraphrase.py` reads the target uids out of `/tmp/queries.json` rather
than resampling, so both sets aim at the SAME 200 documents. Only the query style
changes — a difference in MRR cannot be explained by having drawn easier documents.

**Measured, not trusted.** An LLM told to paraphrase will still sometimes echo a rare
identifier, and a query that does is a known-item query wearing a costume. So every
paraphrase carries a measured query/document overlap — content-word Jaccard for English,
character 3-gram Jaccard for Thai, because Thai has no word boundaries — and
`report_para.py` reports MRR *stratified by that overlap*. If a method only wins in the
high-overlap band, it is winning the old benchmark again, and the table says so.

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

## Paraphrase, 2026-09-19 — the benchmark the first one said was missing

The caveat on the run above was that it measures **known-item** retrieval, which is
exactly what lexical search is best at, so it could not see the case vectors exist for.
Here is that case: same 3,000-doc pool, the **same 200 target documents**, queries
rewritten by `gemma3:27b` under an instruction not to reuse the target's terms.

```
n=200 paraphrase queries · pool=3,000 docs · MRR@20
median query/doc overlap 0.000 · 121 queries share NO term with their target

method                        MRR    R@1   R@10   miss  MRR th  MRR en
FTS (ICU)                   0.046   3.0%   9.0%  88.5%   0.067   0.042
multilingual-e5-small       0.140   9.0%  25.0%  65.5%   0.214   0.127
all-MiniLM-L6 (en only)     0.119   5.5%  24.5%  70.5%   0.006   0.138
multilingual-MiniLM-L12     0.081   3.0%  20.5%  75.0%   0.078   0.082

PAIRED against the known-item run — same documents, different queries
method                      known-item  paraphrase     delta
FTS (ICU)                        0.890       0.046    -0.844
multilingual-e5-small            0.600       0.140    -0.461
```

**The ordering flips.** Embeddings lose by 1.5x on known-item and win by 3x here.

By overlap band, the crossover is sharper — and FTS at 0.002 with no shared terms is
arithmetic, not a verdict: a lexical index cannot rank a document that shares no content
word with the query, except by tokenizer accident.

```
band                    n      FTS   e5-small  all-MiniLM  mMiniLM
0 (no shared terms)   121    0.002      0.096       0.102    0.087
0 - 0.05               79    0.114      0.207       0.147    0.073
```

Thai inverts too. e5 scores 0.308 th / 0.648 en on known-item and **0.214 th / 0.127 en**
on paraphrase — Thai becomes its better half once the lexical crutch is gone. And
`all-MiniLM-L6` scores **0.006** on Thai paraphrase, which is what English-only looks
like with nothing to match on.

### Two checks that could have made these numbers wrong

**Is MRR@20 just clipping?** Partly. `diagnose_para.py`:

```
recall@1  9.0%   recall@20 34.0%   recall@100 56.0%   recall@500 79.0%
median rank of the target: 68 of 3,000     (random would be ~1,500)
```

Signal is real — 22x better than random — and the `@20` window was hiding most of it.

**Are the misses just unfair scoring?** No, and this is the check that mattered. A
paraphrase like *"is the build ready to ship?"* is answered by many documents in a
3,000-doc dev corpus while exactly one is scored correct, which would punish semantic
retrieval most. So: when the target is missed, how related is what came back instead?

```
NULL — two RANDOM pool docs, same model    median 0.838  p90 0.872  p99 0.939
misses — top-1 vs true target              median 0.854  p90 0.887
  above the null's p99    0.0%   <- near-duplicates: none
  below the null's median 23.5%  <- less related than a random doc
```

Absolute cosine 0.854 *looks* like a near-duplicate and is the **72.5th percentile of
the null**. Zero misses clear p99. The misses are genuine retrieval failures, and the
"scoring is unfair" defence is dead. **The null is the whole point here** — e5
embeddings are anisotropic, so any absolute similarity threshold on this model (`>0.9
means related`, cosine dedup, clustering cutoffs) is a guess without a per-corpus null.

## The relation: do they fail on the SAME queries?

`relation.py`. This is what decides whether anything gets built, and it is not answered
by either MRR table.

```
KNOWN-ITEM              e5 HIT  e5 MISS        PARAPHRASE        e5 HIT  e5 MISS
   FTS HIT                 154       41           FTS HIT            18        5
   FTS MISS                  1        4           FTS MISS          50      127

   ORACLE (either) recall@20   98.0%  (+0.5%)     ORACLE recall@20   36.5%  (+2.5%)
```

**Asymmetric containment, not complementarity.** In each regime one method nearly
subsumes the other: e5 adds **1** query in 200 to FTS on known-item; FTS adds **5** to
e5 on paraphrase. Both oracle gaps are tiny, so there is nothing to fuse or route
*within* a regime. What is large is the regime switch itself — paraphrase recall@20 goes
**11.5% -> 34%** by using the other method, which no blend can reach.

**RRF lost in both directions, at every k.**

```
              FTS    e5     RRF k=10   k=60   k=200
known-item   0.872  0.593      0.771   0.733   0.730
paraphrase   0.046  0.139      0.109   0.090   0.091
```

This is stronger than the first result. The known-item failure could be explained away as
"k=60 weights a weak list equally with a strong one" — paraphrase reverses which list is
strong and RRF still loses. Small k helps (k=10 > k=60) and still loses by 0.10 and 0.03.

### A number retracted

The earlier note cited a vector/FTS top-k Jaccard of **0.009-0.018** from a different
corpus, as evidence the two find genuinely different things. Measured here it is
**0.136** on known-item (0.032 on paraphrase, 45% fully disjoint). The claim survives on
paraphrase and is an order of magnitude weaker on known-item. Do not carry a retrieval
statistic across corpora.

## What it all decided

**FTS stays the default and `search` does not read vectors.** Unchanged, now for a
measured reason rather than an untested one.

- **No fusion, no router.** Oracle gaps are +0.5% and +2.5%; RRF loses in both regimes.
- **A `--semantic` mode is justified in principle** — the right method is decided by
  query style, and the user knows their own query style better than a classifier would.
- **But not by quality.** 0.140 MRR, 34% recall@20, median rank 68 of 3,000. That is a
  different failure from FTS's, not a better one.
- `relic embed` therefore ships as **infrastructure that makes this measurable**, not as
  a search path. Every number above is reproducible from this directory.
