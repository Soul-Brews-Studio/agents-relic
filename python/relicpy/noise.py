"""What `--skip-noise` drops, and the proof log that lets you judge the rules.

OPT-IN, and every drop is written to ~/.relic/skipped.jsonl with enough context to
audit it. A filter you cannot inspect is a filter you cannot trust.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Callable

from .repo import default_root
from .unreadable import WALK_RULES

# Numbers followed by an arrow, tab or space — `cat -n`, `rg -n` and Read all emit one
# of those three. Anchored on a boundary, NOT on a line start: a numbered dump is
# often indented or wrapped inside another block.
_NUMBERS = re.compile(r"(?:^|\n|\s)(\d{1,5})(?:\u2192|\t| )")


def has_numbered_lines(text: str) -> bool:
    """THREE CONSECUTIVE ascending line numbers — the signature of a file dump.

    Length is not a proxy for worthlessness. The first version of this filter dropped
    every tool_result over the 4000-char cap, which the analysis said would reclaim 34%
    of the index; auditing the proof log showed it also ate a session-dig result and a
    metrics table — long output that exists nowhere else. Prose, tables and command
    output do not carry an ascending run; a file dump always does.

    Capped at 400 numbers: enough to find a run, bounded for a multi-megabyte blob.
    """
    nums: list[int] = []
    for m in _NUMBERS.finditer(text):
        nums.append(int(m.group(1)))
        if len(nums) > 400:
            break
    run = 1
    for i in range(1, len(nums)):
        run = run + 1 if nums[i] == nums[i - 1] + 1 else 1
        if run >= 3:
            return True
    return False


@dataclass
class NoiseVerdict:
    skip: bool
    rule: str


RULES: list[tuple[str, Callable[[str, str], bool]]] = [
    ("file-readback",
     lambda t, role: role == "tool_result" and len(t) > 500 and has_numbered_lines(t)),
    ("edit-payload",
     lambda t, role: bool(re.match(r"^\[tool_use (Edit|Write|MultiEdit|NotebookEdit)\]", t))),
    ("navigation-call",
     lambda t, role: bool(re.match(r"^\[tool_use (Read|Glob|LS|Grep|TodoWrite)\]", t))),
    ("binary-blob",
     lambda t, role: bool(re.search(r"[A-Za-z0-9+/]{120,}={0,2}", t))),
    ("harness-bookkeeping",
     lambda t, role: bool(re.match(r"^\[tool_result\]\s*<system-reminder>", t))
                     or bool(re.match(r'^\[tool_result\]\s*\{"total_tokens"', t))),
]


def classify(text: str, role: str) -> NoiseVerdict:
    # Prose is NEVER noise, whatever it contains.
    if role in ("user", "assistant", "thinking", "system"):
        return NoiseVerdict(False, "")
    for rule, test in RULES:
        if test(text, role):
            return NoiseVerdict(True, rule)
    return NoiseVerdict(False, "")


def skipped_path(data_root: str | None) -> str:
    return os.path.join(data_root or default_root(), "skipped.jsonl")


def log_skipped(rows: list[dict], data_root: str | None) -> None:
    """One line per dropped event — enough to judge the rule by.

    Also takes walk failures (#99): a PATH the walk could not read, so nothing under it
    was indexed. Those rows carry path/error/ts and a rule from WALK_RULES, which is how
    the readers below tell the two kinds apart. See logSkippedFiles in src/noise.ts.
    """
    if not rows:
        return
    try:
        p = skipped_path(data_root)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "a", encoding="utf-8") as fh:
            fh.write("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows))
    except OSError:
        pass          # the proof log is never worth failing an import for


def read_skipped(data_root: str | None, limit: int = 20) -> dict:
    p = skipped_path(data_root)
    if not os.path.exists(p):
        return {"total": 0, "by_rule": [], "bytes": 0, "rows": []}
    rows = [r for r in _log_rows(p) if r.get("rule") not in WALK_RULES]
    by_rule: dict[str, dict] = {}
    for r in rows:
        b = by_rule.setdefault(r.get("rule", "?"), {"rule": r.get("rule", "?"), "n": 0, "bytes": 0})
        b["n"] += 1
        b["bytes"] += int(r.get("bytes") or 0)
    return {
        "total": len(rows),
        "by_rule": sorted(by_rule.values(), key=lambda x: -x["bytes"]),
        "bytes": sum(int(r.get("bytes") or 0) for r in rows),
        "rows": rows[-limit:],
    }


def _log_rows(p: str) -> list[dict]:
    rows = []
    for line in open(p, encoding="utf-8"):
        if not line.strip():
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            continue          # skip a torn line
    return rows


def read_skipped_files(data_root: str | None) -> dict:
    """Paths the walk could not read, one row per PATH — its newest record, plus how many
    runs logged it. The log is append-only, so one unreadable directory recurs once per
    index run until someone fixes it. Same shape as readSkippedFiles in src/noise.ts."""
    p = skipped_path(data_root)
    by_path: dict[str, dict] = {}
    for r in (_log_rows(p) if os.path.exists(p) else []):
        if r.get("rule") not in WALK_RULES:
            continue
        row = {"rule": r["rule"], "path": str(r.get("path", "")),
               "error": str(r.get("error", "")), "ts": str(r.get("ts", ""))}
        prev = by_path.get(row["path"])
        runs = (prev["runs"] if prev else 0) + 1
        by_path[row["path"]] = {**(row if not prev or row["ts"] >= prev["ts"] else prev), "runs": runs}
    paths = sorted(by_path.values(), key=lambda x: x["ts"], reverse=True)
    by_rule: dict[str, int] = {}
    for x in paths:
        by_rule[x["rule"]] = by_rule.get(x["rule"], 0) + 1
    return {"total": len(paths),
            "by_rule": [{"rule": k, "n": n} for k, n in sorted(by_rule.items(), key=lambda kv: -kv[1])],
            "paths": paths}
