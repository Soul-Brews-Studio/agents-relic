"""Split any result set by language, with intervals — shared by both reports.

"Thai" is the TARGET containing Thai script, which is how the pool is built. A span
lifted from a mixed document can still be pure English, so the queries that actually
carry Thai script are counted too: the Thai column is only as Thai as they are.

The Thai subset of a 200-query run is ~28 queries, so every MRR carries a bootstrap
interval, and "does model X close the gap to FTS" is answered by the PAIRED difference
on the same queries — not by two independent means eyeballed side by side.
"""
import re

import numpy as np

THAI = re.compile(r"[฀-๿]")


def by_language(r: dict, queries: list[dict], order: list[str]) -> None:
    for name, (rr, _ms, _note) in r.items():
        assert len(rr) == len(queries), f"{name}: {len(rr)} scores for {len(queries)} queries"
    th = np.array([bool(q["thai"]) for q in queries])
    script = np.array([bool(THAI.search(q["q"])) for q in queries])
    rng = np.random.default_rng(7)
    # One set of resamples per group, reused for every method, so intervals are paired.
    IDX = {g: rng.integers(0, int(m.sum()), (2000, int(m.sum())))
           for g, m in (("th", th), ("en", ~th), ("all", th | ~th)) if m.any()}

    def ci(v, g):
        """95% bootstrap interval of the mean. At n=28 the interval is the result."""
        return np.quantile(v[IDX[g]].mean(1), [0.025, 0.975]) if g in IDX else (np.nan, np.nan)

    print(f"\n  BY LANGUAGE   th n={int(th.sum())} ({int((th & script).sum())} carry Thai script)   en n={int((~th).sum())}"
          f"   MRR with 95% bootstrap interval\n")
    print(f"  {'method':<26} {'th MRR':>6} {'[95% CI]':>13} {'R@1':>6} {'R@10':>6} {'miss':>6}"
          f"   {'en MRR':>6} {'[95% CI]':>13} {'R@1':>6} {'R@10':>6} {'miss':>6}   {'th-script':>9}")
    print("  " + "-" * 118)
    V = {}
    for k in order:
        if k not in r: continue
        v = np.array([x[0] for x in r[k][0]]); V[k] = v
        row = f"  {k:<26}"
        for g, m in (("th", th), ("en", ~th)):
            if not m.any():
                row += f" {'—':>6} {'':>13} {'':>6} {'':>6} {'':>6}  "
                continue
            lo, hi = ci(v[m], g)
            row += (f" {v[m].mean():6.3f} [{lo:.3f},{hi:.3f}] {(v[m] == 1).mean():6.1%}"
                    f" {(v[m] >= 0.1).mean():6.1%} {(v[m] == 0).mean():6.1%}  ")
        print(row + (f" {v[th & script].mean():9.3f}" if (th & script).any() else f" {'—':>9}"))

    # ------------------------------------------------------------------ the gap, paired
    # The question is whether a model CLOSES the gap to FTS, so the statistic is the paired
    # difference on the same queries, not two independent means eyeballed side by side.
    if "FTS (ICU)" in V:
        print(f"\n  GAP TO FTS, PAIRED — FTS MRR minus model MRR on the same queries, 95% bootstrap\n")
        print(f"  {'method':<26} {'all':>7} {'[95% CI]':>15}   {'th':>7} {'[95% CI]':>15}   {'en':>7} {'[95% CI]':>15}")
        print("  " + "-" * 102)
        f = V["FTS (ICU)"]
        for k, v in V.items():
            if k == "FTS (ICU)": continue
            row = f"  {k:<26}"
            for g, m in (("all", th | ~th), ("th", th), ("en", ~th)):
                if g not in IDX:
                    row += f" {'—':>7} {'':>15}  "
                    continue
                d = f[m] - v[m]
                lo, hi = np.quantile(d[IDX[g]].mean(1), [0.025, 0.975])
                row += f" {d.mean():+7.3f} [{lo:+.3f},{hi:+.3f}]  "
            print(row)
