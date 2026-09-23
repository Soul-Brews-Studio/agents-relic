"""Build the ONE candidate pool every method searches.

Comparing FTS on the whole 3.4 M-event index against embeddings on a 3,000-doc pool
would be rigged — a bigger candidate set is strictly harder. So every method searches
the SAME pool, built once here.

THE POPULATION IS WHAT `relic embed` FEEDS A MODEL. Main tiers (the store's own
main_tiers_filter, the one embed and search share), events of at least 24 characters,
and only their first 2,000 characters — across every bank. A pool drawn from anything
else would benchmark text no model is ever given. It used to be user/assistant/note/
memory roles in a 200-4,000 character band, which embed has never selected on.

UNIFORM OVER EVERY BANK, NOT THE FIRST SHARDS. This used to walk shards in
pick_shards() order and stop once it had enough rows. That order is bank-alphabetical,
so once banks arrived the first bank filled the pool: on 2026-09-23, 2,993 of 3,000 docs
and all 400 Thai ones came from `codex`, one bank of 12. Now every shard is read, through
the same 1-in-N uid range `relic langs` uses (src/langs.ts sampleWhere): a uid is a sha1
in hex, so `uid < '<cut>'` is a uniform, deterministic sample pushed into Lance.

A PER-SHARD CAP, per language. One busy shard can still hold a large share of the index;
past BENCH_SHARD_CAP sampled texts of one language, a shard contributes a seeded random
BENCH_SHARD_CAP of them. The manifest records how many shards the cap touched.

IDENTICAL TEXTS ARE ONE DOCUMENT. The codex pool held 839 docs sharing their exact text
with another (Codex rollouts re-log turns; one file gave 75 copies of one message). With
one uid as the known-item answer, the target's rank among its own copies is decided by
tie-breaking. So each distinct normalized slice is a candidate once.

Thai is deliberately over-sampled — 400 of 3,000, drawn from the Thai candidates of
every bank — so the Thai number is not a handful of queries wide.

Writes the pool to BENCH_POOL and a manifest (sampling, seed, bank/shard/role counts,
dedupe count; counts only, never text) to BENCH_POOL_MANIFEST, default pool_manifest.json
beside it.
"""
import collections, json, os, random, re, sys, time
# The repo's own python/ package, resolved from THIS file. It used to be an absolute
# path to one worktree, which silently benchmarked another checkout's code — or failed
# outright once that worktree was removed.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python"))
from relicpy.models import Scope
from relicpy.query import pick_shards
from relicpy.store import LanceStore

SEED = 1729
POOL, N_TH = 3000, 400
MIN_CHARS, MAX_CHARS = 24, 2000                  # relic embed's defaults
SAMPLE = int(os.environ.get("BENCH_SAMPLE", "16"))
CAP = int(os.environ.get("BENCH_SHARD_CAP", "1000"))
THAI = re.compile(r"[฀-๿]")
OUT = os.environ.get("BENCH_POOL", "/tmp/pool.json")
MANIFEST = os.environ.get("BENCH_POOL_MANIFEST", os.path.join(os.path.dirname(OUT), "pool_manifest.json"))

cut = max(1, min(0xFFFF, 0x10000 // SAMPLE))
UID_WHERE = f"uid < '{cut:04x}'"                 # as sampleWhere() in src/langs.ts
rng = random.Random(SEED)

cands = {True: [], False: []}
seen = set()
stats = collections.Counter()
capped, failed = [], []
shards = pick_shards(Scope())
t0 = time.time()
for i, sh in enumerate(sorted(shards, key=lambda s: s.key), 1):
    try:
        st = LanceStore.open(sh.dir)
        t = st._existing("events")
        if t is None:
            continue
        a = (t.search().where(f"{UID_WHERE} AND {st.main_tiers_filter()}")
             .select(["uid", "text", "role", "repo_key"]).limit(None).to_arrow())
    except Exception as e:
        failed.append(f"{sh.key}: {str(e)[:120]}")
        continue
    stats["shards_read"] += 1
    mine = {True: [], False: []}
    for r in a.to_pylist():
        text = str(r["text"] or "")
        if len(text) < MIN_CHARS:                # eligibility on the full length, as embed
            continue
        stats["sampled_eligible"] += 1
        text = text[:MAX_CHARS]                  # ...and only the slice embed sends
        th = bool(THAI.search(text))
        stats["sampled_thai"] += th
        mine[th].append({"uid": r["uid"], "text": text, "role": r["role"], "repo_key": r["repo_key"],
                         "bank": sh.bank, "shard": sh.key})
    for th in (True, False):
        rows = sorted(mine[th], key=lambda r: r["uid"])
        if len(rows) > CAP:
            capped.append(sh.key)
            stats["dropped_by_cap"] += len(rows) - CAP
            rows = rng.sample(rows, CAP)
        for r in rows:
            key = " ".join(r["text"].split())
            if key in seen:
                stats["dropped_duplicate"] += 1
                continue
            seen.add(key)
            cands[th].append(r)
    if i % 50 == 0 or i == len(shards):
        print(f"  {i}/{len(shards)} shards  {stats['sampled_eligible']:,} sampled  "
              f"{len(cands[True]):,} th / {len(cands[False]):,} other candidates  {time.time() - t0:.0f}s",
              flush=True)

if len(cands[True]) < N_TH or len(cands[False]) < POOL - N_TH:
    raise SystemExit(f"too few candidates ({len(cands[True])} Thai, {len(cands[False])} other) —"
                     f" lower BENCH_SAMPLE")
pool = rng.sample(cands[True], N_TH) + rng.sample(cands[False], POOL - N_TH)
rng.shuffle(pool)
json.dump(pool, open(OUT, "w"), ensure_ascii=False)

count = lambda key, rows: dict(collections.Counter(r[key] for r in rows).most_common())
th_rows = [r for r in pool if THAI.search(r["text"])]
by_shard = collections.Counter(r["shard"] for r in pool)
m = {
    "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
    "seed": SEED,
    "population": {"main_tiers": True, "min_chars": MIN_CHARS, "max_chars": MAX_CHARS, "banks": "all"},
    "sampling": {"one_in": SAMPLE, "uid_where": UID_WHERE, "rate": cut / 0x10000,
                 "shard_cap_per_language": CAP, "shards_capped": len(set(capped))},
    "shards": {"in_scope": len(shards), "read": stats["shards_read"], "failed": failed,
               "contributing_to_pool": len(by_shard), "max_docs_from_one_shard": max(by_shard.values())},
    "sampled_eligible": stats["sampled_eligible"],
    "sampled_thai": stats["sampled_thai"],
    "sampled_thai_share": round(stats["sampled_thai"] / max(1, stats["sampled_eligible"]), 4),
    "estimated_population": round(stats["sampled_eligible"] / (cut / 0x10000)),
    "dropped_by_cap": stats["dropped_by_cap"],
    "dropped_duplicate": stats["dropped_duplicate"],
    "candidates": {"thai": len(cands[True]), "other": len(cands[False])},
    "pool": {"docs": len(pool), "thai": len(th_rows), "distinct_texts": len({" ".join(r["text"].split()) for r in pool}),
             "banks": count("bank", pool), "thai_by_bank": count("bank", th_rows), "roles": count("role", pool),
             "distinct_repos": len({r["repo_key"] for r in pool})},
}
json.dump(m, open(MANIFEST, "w"), indent=2, ensure_ascii=False)
print(f"  pool: {len(pool)} docs — {len(th_rows)} containing Thai, {len(pool) - len(th_rows)} not")
print(f"  sampled 1-in-{SAMPLE}: {m['sampled_eligible']:,} eligible ({m['sampled_thai_share']:.1%} Thai) in"
      f" {stats['shards_read']} shards; {m['dropped_duplicate']:,} duplicates and {m['dropped_by_cap']:,} over"
      f" the cap dropped")
print(f"  pool spans {len(m['pool']['banks'])} banks, {len(by_shard)} shards, {m['pool']['distinct_repos']} repos"
      f"  ·  banks {m['pool']['banks']}")
print(f"  manifest: {MANIFEST}")
