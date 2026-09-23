"""Finding files on disk. One walker per layout, gated by the source registry.

THREE TIERS, and the third is the one that gets missed:

    <root>/<project>/<uuid>.jsonl                                   session
    <root>/<project>/<uuid>/subagents/<agent>.jsonl                 subagent
    <root>/<project>/<uuid>/subagents/workflows/wf_<run>/agent-*    workflow_agent

The workflow tier sits one directory deeper than an obvious glob reaches — which is
the bug in /dig --deep, silently dropping ~73% of the corpus by file count.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional

from .models import ParsedFile
from .sources import SourceDef, bank_of, load_sources
from .unreadable import begin_walk, dir_unreadable, reachable, walk_error

Parser = Callable[[str], ParsedFile]


@dataclass
class Found:
    path: str
    project_dir: str          # raw encoded dir name (display only — the encoding is lossy)
    tier: str
    source: str
    bank: str                 # top level of the shard path
    workflow_run_id: Optional[str]
    agent_id: Optional[str]
    mtime: int
    size: int
    parser: Parser


# A failed scandir or stat still yields nothing, but no longer SAYS nothing: anything
# other than ENOENT is reported once per path (#99). See unreadable.py.
def _stat(p: str):
    try:
        st = os.stat(p)
        return int(st.st_mtime), st.st_size
    except OSError as e:
        walk_error(p, e)
        return None


def _dirs(p: str) -> list[str]:
    """Real directories only — NEVER symlinks.

    `os.scandir(...).is_dir()` FOLLOWS symlinks by default; Node's
    `Dirent.isDirectory()` does not (it reports `isSymbolicLink()` instead). Porting
    the walker without `follow_symlinks=False` therefore changed behaviour silently
    and badly: a vault contains `ψ/incubate/<org>/<repo>/origin`, a symlink back out
    into the ghq tree, so the recursion walked from one vault into a checkout and into
    OTHER vaults. Measured: 68,719 notes discovered against the reference's 10,129,
    with 58,819 paths the TypeScript never returns.

    The entry point of `_walk_vaults` resolves its symlink deliberately and once, which
    is a different decision from following every symlink met while recursing.
    """
    try:
        return sorted(e.name for e in os.scandir(p) if e.is_dir(follow_symlinks=False))
    except OSError as e:
        dir_unreadable(p, e)
        return []


def _files(p: str, ext: str = ".jsonl") -> list[str]:
    try:
        return sorted(e.name for e in os.scandir(p)
                      if e.is_file(follow_symlinks=False) and e.name.endswith(ext))
    except OSError as e:
        dir_unreadable(p, e)
        return []


def _walk_subagents(subagents, project, since_ms, out, key, parser):
    """One `subagents/` directory: its agent transcripts, and the workflow tier beneath.

    Called with two different bases — the project-level one and the per-session one — so
    the two cannot drift about what a subagent directory contains.
    """
    if not reachable(subagents):
        return
    for f in _files(subagents):
        p = os.path.join(subagents, f)
        st = _stat(p)
        if not st or (since_ms and st[0] * 1000 < since_ms):
            continue
        out.append(Found(p, project, "subagent", key, "", None,
                         f[:-6] if f.endswith(".jsonl") else f, st[0], st[1], parser))

    # --- the tier everyone forgets -----------------------------------
    workflows = os.path.join(subagents, "workflows")
    if not reachable(workflows):
        return
    for run in _dirs(workflows):
        if not run.startswith("wf_"):
            continue
        for f in _files(os.path.join(workflows, run)):
            # journal.jsonl is the RUNNER's event log, not a transcript.
            if f == "journal.jsonl":
                continue
            p = os.path.join(workflows, run, f)
            st = _stat(p)
            if not st or (since_ms and st[0] * 1000 < since_ms):
                continue
            out.append(Found(p, project, "workflow_agent", key, "", run,
                             f[:-6] if f.endswith(".jsonl") else f,
                             st[0], st[1], parser))


def _walk_claude(root, since_ms, out, key, parser):
    for project in _dirs(root):
        pdir = os.path.join(root, project)

        for f in _files(pdir):
            p = os.path.join(pdir, f)
            st = _stat(p)
            if not st or (since_ms and st[0] * 1000 < since_ms):
                continue
            out.append(Found(p, project, "session", key, "", None, None, st[0], st[1], parser))

        # A `subagents/` DIRECTLY under the project dir, with no session-uuid directory
        # between. Found 2026-09-19 while indexing a second account's corpus: 14 real
        # subagent transcripts across two roots that no relic run had ever seen, because
        # the loop below only ever looks one level deeper. `subagents` is itself returned
        # by _dirs(pdir), so that loop treats it as a session dir and looks for
        # <project>/subagents/subagents — which does not exist, so it is skipped in
        # silence. Discovery that misses a shape reports success with a smaller number.
        _walk_subagents(os.path.join(pdir, "subagents"), project, since_ms, out, key, parser)

        for session_dir in _dirs(pdir):
            if session_dir == "subagents":
                continue          # handled above, do not walk it twice
            _walk_subagents(os.path.join(pdir, session_dir, "subagents"),
                            project, since_ms, out, key, parser)


def _walk_flat(root, since_ms, out, key, parser, depth=0):
    """Codex rollouts nest by date: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl"""
    for f in _files(root):
        p = os.path.join(root, f)
        st = _stat(p)
        if not st or (since_ms and st[0] * 1000 < since_ms):
            continue
        out.append(Found(p, key, "session", key, "", None, None, st[0], st[1], parser))
    if depth >= 4:
        return          # date nesting is 3 deep; 4 is slack, not a full-tree sweep
    for d in _dirs(root):
        _walk_flat(os.path.join(root, d), since_ms, out, key, parser, depth + 1)


def _walk_omp(root, since_ms, out, key, parser):
    """One directory per cwd, flat .jsonl files inside.

    Deliberately not _walk_flat: that sets project_dir to the source key and throws the
    per-cwd directory away, which is the one thing "which session am I in" needs.
    """
    for project in _dirs(root):
        pdir = os.path.join(root, project)
        for f in _files(pdir):
            p = os.path.join(pdir, f)
            st = _stat(p)
            if not st or (since_ms and st[0] * 1000 < since_ms):
                continue
            out.append(Found(p, project, "session", key, "", None, None, st[0], st[1], parser))


def _walk_vault(root, since_ms, out, key, parser, depth=0):
    """`<repo>/ψ/**.md`. Bounded by extension and a skip list, NOT by depth — the vault
    nests arbitrarily, so a depth cap would silently drop the deepest, newest notes."""
    if depth > 12:          # pathological-symlink guard, not a scope limit
        return
    for f in _files(root, ".md"):
        p = os.path.join(root, f)
        st = _stat(p)
        if not st or (since_ms and st[0] * 1000 < since_ms):
            continue
        out.append(Found(p, key, "note", key, "", None, None, st[0], st[1], parser))
    for d in _dirs(root):
        if d in ("node_modules", ".git"):
            continue
        _walk_vault(os.path.join(root, d), since_ms, out, key, parser, depth + 1)


def _walk_vaults(root, since_ms, out, key, parser):
    """EVERY oracle's vault. See src/discover.ts for the three silent-failure notes:
    resolve the entry point (a symlinked ψ is invisible to scandir's is_dir), never
    follow symlinks while recursing, and dedupe by CONTAINMENT because a vault can
    contain another vault."""
    resolved: list[str] = []
    for org in _dirs(root):
        org_path = os.path.join(root, org)
        for repo in _dirs(org_path):
            psi = os.path.join(org_path, repo, "ψ")
            try:
                os.lstat(psi)
                resolved.append(os.path.realpath(psi))
            except OSError:
                continue
    resolved.sort(key=len)
    kept: list[str] = []
    for real in resolved:
        if any(real == k or real.startswith(k + "/") for k in kept):
            continue
        kept.append(real)
    for real in kept:
        _walk_vault(real, since_ms, out, key, parser)


def _walk_memory(root, since_ms, out, key, parser):
    """`<root>/<encoded-project>/memory/*.md`. MEMORY.md is skipped — it is an index OF
    the others, so indexing it repeats every memory's description as a second hit."""
    for project in _dirs(root):
        d = os.path.join(root, project, "memory")
        if not reachable(d):
            continue
        for f in _files(d, ".md"):
            if f == "MEMORY.md":
                continue
            p = os.path.join(d, f)
            st = _stat(p)
            if not st or (since_ms and st[0] * 1000 < since_ms):
                continue
            out.append(Found(p, project, "memory", key, "", None, None, st[0], st[1], parser))


def _walk_claude_home(home, since_ms, out, src_key, parser) -> None:
    """Every `projects*` root inside ONE agent home, under one source and one bank.

    The builtins name three roots inside ~/.claude by hand — and that is how
    `projects-1sep-tue2026` went missing once already: it lived only in a sources.json
    that got deleted, so a rebuild indexed two of three roots and reported success.
    Enumerating the home removes the hand-maintained list, and a new snapshot directory
    is picked up without a code change.

    `projects` FIRST when present, so the live root is scanned before any snapshot and
    a killed run has the most useful half.
    """
    try:
        roots = [d for d in os.listdir(home)
                 if (d == "projects" or d.startswith("projects-"))
                 and os.path.isdir(os.path.join(home, d))]
    except OSError as e:
        dir_unreadable(home, e)     # a declared home that cannot be read must say so (#99)
        return
    roots.sort(key=lambda d: (d != "projects", d))
    for r in roots:
        _walk_claude(os.path.join(home, r), since_ms, out, src_key, parser)


_WALKERS = {
    "claude-tiers": _walk_claude, "claude-home": _walk_claude_home,
    "flat": _walk_flat, "omp": _walk_omp,
    "vault": _walk_vault, "vaults": _walk_vaults, "memory": _walk_memory,
}


def discover(only: Optional[list[str]], since_ms: Optional[int],
             path_override: Optional[tuple[str, str]] = None) -> list[Found]:
    """`path_override` is (source key, root): run ONE source against a path it does not
    normally walk.

    sources.py has documented this flag since the oracle-vault entry was written and it
    did not exist — the comment told you to run a command that fails. It exists now
    because a real vault needed it: 55 worktree vaults (<repo>/wt/<slug>/ψ) across 17
    repos are real directories the `vaults` walker never descends into.

    Deliberately NOT a way to widen a walk. It overrides one source's root for one run,
    so the walker, parser and bank are unchanged — which is what makes the result land
    where the rest of that source's rows already live.
    """
    out: list[Found] = []
    begin_walk()          # walk_failures() after this call describes this walk and no other
    for src in load_sources():
        wanted = (src.key in only) if only else src.enabled
        if not wanted:
            continue
        walker = _WALKERS.get(src.walk)
        if not walker:
            # Hermes is SQLite, and its reader is not ported. This used to `continue` in
            # silence, so `--corpus hermes` indexed 0 files and exited 0 — the exact
            # report in #99. Said BEFORE the root check, so a missing ~/.hermes cannot
            # turn it back into a quiet zero.
            print(f"relic-py: {src.key}: Hermes is not supported by relic-py yet (walk "
                  f'"{src.walk}" is not ported) — nothing was read from it. The TypeScript '
                  f"CLI reads it: relic index --corpus {src.key}", file=sys.stderr)
            continue
        root = path_override[1] if path_override and path_override[0] == src.key else src.path
        # A missing root is a source this machine does not have; an unreadable one is not.
        if not reachable(root):
            continue
        before = len(out)
        walker(root, since_ms, out, src.key, src.parser)
        # Stamp the bank on what this source contributed, rather than threading it
        # through every walker: a file's bank is a property of its SOURCE.
        bank = bank_of(src)
        for i in range(before, len(out)):
            out[i].bank = bank
    return out


def parse_since(spec: Optional[str]) -> Optional[int]:
    """"7d" | "30m" | "12h" | "2026-09-01" -> epoch ms, or None."""
    if not spec:
        return None
    m = re.match(r"^(\d+)([mhd])$", spec)
    if m:
        n = int(m.group(1))
        mult = {"m": 60_000, "h": 3_600_000, "d": 86_400_000}[m.group(2)]
        return int(datetime.now(timezone.utc).timestamp() * 1000) - n * mult
    for fmt in ("%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%d", "%Y/%m/%d"):
        try:
            dt = datetime.strptime(spec, fmt)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000)
        except ValueError:
            continue
    return None
