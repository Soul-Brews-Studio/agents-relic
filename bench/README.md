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
# The pool is built from one machine's private sessions: it lives in a dated directory
# outside the repo, and NOT in /tmp — the 2026-09-18 inputs were gone five days later.
B=~/.relic/bench/2026-09-23/allbanks
export BENCH_POOL=$B/pool.json BENCH_QUERIES=$B/queries.json BENCH_PARA=$B/queries_para.json \
       BENCH_DOCS=$B/bench_docs.json BENCH_FTS_DB=$B/fts_lance BENCH_EMB_CACHE=$B/emb \
       BENCH_FTS=$B/bench_fts.pkl BENCH_ALL=$B/bench_all.pkl BENCH_BATCH=32
ST="uv run --with sentence-transformers python"

uv run python ../bench/build_pool.py        # 3,000 docs, 400 with Thai
uv run python ../bench/make_queries.py      # 200 known-item queries
BENCH_THAI_ONLY=1 BENCH_QUERIES=$B/queries_th.json uv run python ../bench/make_queries.py  # 200, Thai targets only
uv run python ../bench/make_paraphrase.py   # 200 paraphrases, same targets (gemma3:27b, ~13 min)
BENCH_EXTRA=$B/queries_th.json uv run python ../bench/manifest.py  # sha256 + counts -> $B/manifest.json
uv run python ../bench/bench.py             # FTS (ICU) baseline
$ST ../bench/bench_emb.py                   # every model in bench_models.py
uv run python ../bench/bench_expand.py      # translation query expansion
uv run python ../bench/report.py

# paraphrase — same pool, SAME 200 target documents, different queries
BENCH_QUERIES=$BENCH_PARA BENCH_FTS=$B/bench_fts_para.pkl uv run python ../bench/bench.py
BENCH_QUERIES=$BENCH_PARA BENCH_FTS=$B/bench_fts_para.pkl BENCH_ALL=$B/bench_all_para.pkl \
  $ST ../bench/bench_emb.py
BENCH_ALL=$B/bench_all_para.pkl BENCH_ALL_KNOWN=$B/bench_all.pkl uv run python ../bench/report_para.py
$ST ../bench/diagnose_para.py               # full-ranking recall + both nulls, every model

$ST ../bench/span_reach.py                  # known-item: is the span inside the model's window?
$ST ../bench/cost.py                        # load / docs/s / one query, timed on their own
uv run python ../bench/storage.py           # bytes and scan time per 1M vectors, per dim
```

Every path is an env var so every run uses the same scripts. A second copy of `bench.py`
that "only differs in the query file" is how two benchmarks quietly stop being comparable.

| env var | default | what it switches |
|---|---|---|
| `BENCH_POOL` `BENCH_QUERIES` `BENCH_PARA` | `/tmp/…` | the inputs |
| `BENCH_DOCS` `BENCH_FTS_DB` | `/tmp/bench_docs.json` `/tmp/bench_fts` | pool text and its FTS index — private, they hold the text |
| `BENCH_FTS` `BENCH_ALL` | `/tmp/bench_fts.pkl` `/tmp/bench_all.pkl` | per-query scores |
| `BENCH_EMB_CACHE` | unset | cache document vectors, keyed on model + prefix + window + text |
| `BENCH_MODELS` | all | `label,label` — a subset of `bench_models.py`; `ollama:` names run through Ollama |
| `BENCH_SAMPLE` `BENCH_SHARD_CAP` | 16, 1000 | `build_pool.py`: 1-in-N uid range, and the per-shard, per-language cap |
| `BENCH_MAX_LOAD` | 60 | `cost.py` takes a row only below this 1-min load average |
| `BENCH_BATCH` | 64 | encode batch size; changes throughput, not rankings |
| `BENCH_DEDUP=1` | off | an identical copy of the target counts as the target |
| `BENCH_MAX_CHARS` | unset | cut documents before embedding, as `relic embed` does at 2,000 |
| `BENCH_THAI_ONLY=1` `BENCH_N` | off, 200 | draw known-item targets from the Thai documents only |

### Why the paraphrase set is paired, and why the generator is measured

**Paired.** `make_paraphrase.py` reads the target uids out of `BENCH_QUERIES` rather
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

## Thai with 768/1024-dim multilingual models, 2026-09-23 (#103)

The line below — *"on Thai, lexical beats every vector model ~2.5x"* — was measured on
384-dim models only. `relic langs` (#98) measured **12.2%** of eligible events carrying
Thai, so whether a bigger model closes the gap decides `embed`'s default (#101). Asked by
Yutthakit (ChaiKlang Oracle).

**The pool was rebuilt, and every row re-run on it.** The first build this morning walked
banks alphabetically and gave a pool 2,993/3,000 from `codex`. `build_pool.py` now draws
what `relic embed` feeds a model — main tiers, text >= 24 chars, first 2,000 chars —
from **all banks** through the `uid < '1000'` range (1-in-16, as `relic langs` samples),
with a 1,000-per-shard-per-language cap and exact-text dedupe:

```
sampled 255,887 eligible events in 1,136 shards   12.3% carry Thai  (relic langs: 12.2%)
dropped: 77,062 duplicate texts, 77,107 over the shard cap (51 shards capped)
pool: 3,000 docs, 400 Thai · 11 banks, 375 shards, 235 repos · max 49 docs from one shard
      peer-projects 1,736 · projects-1sep 374 · projects 222 · codex 220 · vaults 181 · ...
```

Cap choice, measured: no cap puts 244 docs (8%) from one shard; cap 300 drops 55% of the
sample; 1,000 keeps any one shard under 1.7%. Pool, queries and the per-query results
stay in `~/.relic/bench/2026-09-23/allbanks/`; `manifest.json` there holds their sha256
(pool `c559ec60953a33ca`, known-item `707fc76a38fe0ad5`, Thai-only `dfbbb5d6c70c9a4c`,
paraphrase `fa8bc3d958224e8d`, generator `gemma3:27b` `a418f5838eaf`).

**Config.** FTS is `bench.py`'s own index over the pool, built with the settings of
`relicpy.store._create_fts` at main `9089b14`: ICU tokenizer, `stem=False`,
`remove_stop_words=False` (#114), `max_token_length=128`; lancedb 0.39.0. relic's own
index is only read. Models on MPS via sentence-transformers (`st`) or a local Ollama
(`ollama`), prefixes from each model card (`bench_models.py`). `embeddinggemma-300m`
has no `st` row: the HF copy is gated (401). `emb-gemma raw` and `Qwen3, no instruct`
are controls: raw text both ways, which is what relic's ollama provider sends today.

**Parity.** `bge-m3` through `st` and through Ollama score 0.562/0.563 known-item,
0.345/0.344 Thai-only, 0.194/0.195 paraphrase — the same model. The Ollama rows are
therefore reported in the same table.

**Two scorings, one answer.** Scored by uid and duplicate-aware (`BENCH_DEDUP=1`, an
identical copy of the target counts) give identical MRR on all three sets, as they must:
the pool holds each distinct text once. On the codex-only pool (839 docs sharing text)
dedupe raised FTS known-item 0.799 -> 0.905 and moved every model by +0.02-0.08.

```
MRR@20 · pool 3,000 (400 Thai) · Thai-only = 200 known-item queries, every target Thai

                                   known-item (n=200)       Thai-only    paraphrase (n=200)
method              rt     dim     all     th(48)   en      th (200)     all     th(48)   en
FTS (ICU)           —       —     0.941    0.842  0.972     0.871       0.032    0.050  0.027
multilingual-MiniLM st     384    0.394    0.233  0.445     0.225       0.063    0.092  0.054
multilingual-e5-sm  st     384    0.588    0.293  0.682     0.347       0.143    0.232  0.114
all-MiniLM-L6 (en)  st     384    0.509    0.245  0.592     0.258       0.091    0.022  0.113
bge-m3              st    1024    0.562    0.309  0.642     0.345       0.194    0.260  0.173
bge-m3              ollama 1024   0.563    0.309  0.643     0.344       0.195    0.260  0.174
Qwen3-Emb-0.6B      st    1024    0.536    0.348  0.596     0.414       0.253    0.291  0.242
  no instruct       st    1024    0.466    0.280  0.525     0.350       0.187    0.251  0.166
embeddinggemma      ollama 768    0.646    0.398  0.725     0.476       0.318    0.398  0.293
  raw (no prefix)   ollama 768    0.557    0.252  0.654     0.330       0.170    0.219  0.154

FTS minus model, Thai-only, paired 95% bootstrap:
  e5-small +0.524 [+0.461,+0.585]   bge-m3 +0.526 [+0.463,+0.586]
  Qwen3    +0.457 [+0.392,+0.521]   embeddinggemma +0.395 [+0.330,+0.454]
```

Of the 48 known-item "Thai" targets only 19 queries carry Thai script (a span lifted from
a mixed document is often English), which is why the Thai-only set exists: 200 targets,
105 queries in Thai script.

**Answer: no, a bigger model does not close the Thai known-item gap.** FTS 0.871 on the
Thai-only set; the best vector model, embeddinggemma with its prompts, 0.476 — **1.8x**,
not 2.5x, but every interval excludes closing it. `bge-m3` at 1024 dims scores the same
as `e5-small` at 384 (0.345 vs 0.347). It is not the window: `span_reach.py` puts 93% of
e5's Thai spans inside its 512 tokens, and e5 scores 0.363 on those — bge-m3's 8,192
tokens buy nothing here.

**Where size does pay is paraphrase**, the case vectors exist for. Every larger model
beats every 384-dim one there, on Thai too: embeddinggemma 0.318 (0.398 th), Qwen3 0.253,
bge-m3 0.194, against e5-small 0.143. `diagnose_para.py`: embeddinggemma puts the target
in the top 20 for 63.5% of paraphrases (e5-small 32.5%), median rank 8 of 3,000 (e5 78),
59% even with zero shared terms.

**Prompts are half of embeddinggemma's result.** Without its `task:`/`title:` prefixes it
drops from 0.646 to 0.557 known-item, 0.476 to 0.330 Thai, 0.318 to 0.170 paraphrase —
back among the others. Qwen3 without its query instruction loses 0.06-0.07 on every set. relic's
ollama provider sends raw text, so as shipped it would get the `raw` rows.

**Cost**, `cost.py`, taken at a 1-min load of 4-9 (600 docs cut at 2,000 chars, batch 32,
M-series MPS; Ollama loads lazily, so its load column is not comparable):

```
model                   rt      dim   docs/s   1 query
multilingual-MiniLM     st      384    1,408     5.7 ms
multilingual-e5-small   st      384      643     5.7 ms
all-MiniLM-L6           st      384    1,618     3.3 ms
bge-m3                  st     1024       27    13.1 ms
Qwen3-Embedding-0.6B    st     1024       32    19.8 ms
bge-m3                  ollama 1024       46    16.5 ms
embeddinggemma          ollama  768       84    12.8 ms
```

At 4.1 M eligible events (the sample scaled up), 84 docs/s is ~14 h of backfill;
27 docs/s is ~42 h.

**The codex-only pool agrees.** Same scripts on the 2,993-from-`codex` pool (st rows only;
no Ollama rows, no Thai-only set there): Thai known-item FTS 0.720 (dedup) vs bge-m3
0.303, Qwen3 0.282, e5-small 0.315 — no model closes it; on paraphrase bge-m3 0.268 and
Qwen3 0.213 beat e5-small 0.138. Same two conclusions on both pools.

**Not measured.** `embeddinggemma` through `st` (gated). Throughput of the ranking runs
themselves (load 28-53 while they ran: those notes are not quoted). Ollama's per-process
load time. Ollama rows on the codex-only pool. Any model above 0.6 B parameters.

## What it decided

**Nothing ships.** FTS wins by a wide margin and the alternatives are neutral or worse.

- **Embeddings miss 22–40% of queries entirely** where FTS misses 2.5%.
- **On Thai, lexical beats every vector model ~2.5x** (0.768 vs 0.308). ICU word
  segmentation is doing the work; no 384-dim multilingual model came close. *(2026-09-23,
  #103: nor do 768/1024-dim ones — 1.8x at best, see above.)*
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
