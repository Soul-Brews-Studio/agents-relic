"""What is running RIGHT NOW — answered from the filesystem, never from the index.

The index is always behind live work by definition: a transcript is appended to while
it is read, and an import that just ran cannot include the line written a second later.
So liveness here is mtime, which is exactly as fresh as the work itself.
"""

from __future__ import annotations

import json
import os
import re
import time
from typing import Optional

from .discover import _dirs, _files, _stat
from .sources import load_sources


def age(mtime: int) -> int:
    return max(0, int(time.time()) - mtime)


def human_age(sec: int) -> str:
    if sec < 60:
        return f"{sec}s"
    if sec < 3600:
        return f"{sec // 60}m"
    if sec < 86400:
        return f"{sec // 3600}h"
    return f"{sec // 86400}d"


def live_roots() -> list[str]:
    """Transcript layouts only, each path ONCE.

    Two sources can name the same directory — `claude-memory` reads out of
    ~/.claude/projects, the root `claude-live` already walks — and iterating sources
    without deduping reported every live session TWICE.
    """
    seen: list[str] = []
    for src in load_sources():
        if src.walk not in ("claude-tiers", "omp"):
            continue
        if not os.path.exists(src.path) or src.path in seen:
            continue
        seen.append(src.path)
    return seen


def tree_files(pdir: str, uuid: str) -> list[dict]:
    """Every transcript in one session's tree, with its age."""
    out: list[dict] = []
    p = os.path.join(pdir, f"{uuid}.jsonl")
    st = _stat(p)
    if st:
        out.append({"path": p, "tier": "session", "age_sec": age(st[0]),
                    "agent_id": None, "workflow_run_id": None})
    subagents = os.path.join(pdir, uuid, "subagents")
    for f in _files(subagents):
        st = _stat(os.path.join(subagents, f))
        if st:
            out.append({"path": os.path.join(subagents, f), "tier": "subagent",
                        "age_sec": age(st[0]), "agent_id": f[:-6], "workflow_run_id": None})
    workflows = os.path.join(subagents, "workflows")
    for run in _dirs(workflows):
        if not run.startswith("wf_"):
            continue
        for f in _files(os.path.join(workflows, run)):
            if f == "journal.jsonl":
                continue
            st = _stat(os.path.join(workflows, run, f))
            if st:
                out.append({"path": os.path.join(workflows, run, f), "tier": "workflow_agent",
                            "age_sec": age(st[0]), "agent_id": f[:-6], "workflow_run_id": run})
    return out


def _peek(path: str) -> dict:
    cwd = title = None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            head = fh.read(262_144)
        for line in head.split("\n"):
            if not line.strip():
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if not isinstance(rec, dict):
                continue
            if not cwd:
                cwd = rec.get("cwd") or (rec.get("payload") or {}).get("cwd")
            if rec.get("type") == "ai-title" and rec.get("aiTitle"):
                title = rec["aiTitle"]
    except OSError:
        pass
    return {"cwd": cwd, "title": title}


def fresh_candidates(roots: list[str], window_sec: int) -> list[dict]:
    """The sweep: every project directory, asked whether anything in it is recent.

    This is the whole cost of "what is running" — resolving ONE session is ~1 ms, this
    is 60+ ms over ~1,500 directories.
    """
    out: list[dict] = []
    for root in roots:
        for project in _dirs(root):
            pdir = os.path.join(root, project)
            fresh: list[str] = []
            for f in _files(pdir):
                st = _stat(os.path.join(pdir, f))
                if st and age(st[0]) <= window_sec:
                    fresh.append(f[:-6] if f.endswith(".jsonl") else f)
            for d in _dirs(pdir):
                st = _stat(os.path.join(pdir, d, "subagents"))
                if st and age(st[0]) <= window_sec and d not in fresh:
                    fresh.append(d)
            if fresh:
                out.append({"project": pdir, "uuids": fresh})
    return out


def live_sessions(window_sec: int = 300, limit: int = 20) -> list[dict]:
    found: list[dict] = []
    for cand in fresh_candidates(live_roots(), window_sec):
        for uuid in cand["uuids"]:
            files = [f for f in tree_files(cand["project"], uuid) if f["age_sec"] <= window_sec]
            if not files:
                continue
            meta = _peek(os.path.join(cand["project"], f"{uuid}.jsonl"))
            found.append({
                "session_uuid": uuid, "project_dir": cand["project"],
                "cwd": meta["cwd"], "title": meta["title"], "files": files,
                "age_sec": min(f["age_sec"] for f in files),
                "agents": sum(1 for f in files if f["tier"] != "session"),
            })
    found.sort(key=lambda x: x["age_sec"])
    return found[:limit]


_ENV_SESSION_KEYS = ("CLAUDE_CODE_SESSION_ID", "CODEX_THREAD_ID",
                     "CODEX_COMPANION_SESSION_ID")
_UUIDISH = re.compile(r"^[0-9a-fA-F][0-9a-fA-F-]{7,}$")


def session_id_from_env(env=None) -> Optional[tuple[str, str]]:
    """The host's OWN answer to "which session am I", as (id, which-variable).

    Both hosts publish it and relic read neither, so `now` inferred by mtime an answer
    that was sitting in a variable. It matters most for Codex, which the cwd scan below
    CANNOT find at all — codex is the only source with no project-dir layout, so no
    encoding of a cwd addresses it. Observed on white.local inside a live Codex session:
    `relic now` said "no session transcript for this directory" while $CODEX_THREAD_ID
    held the id and `relic session <id>` resolved seven transcripts from it.

    Shape-checked rather than trusted: these variables are inherited by every child
    process, and an empty or placeholder value must not beat a working scan.
    """
    env = os.environ if env is None else env
    for key in _ENV_SESSION_KEYS:
        v = (env.get(key) or "").strip()
        if _UUIDISH.match(v):
            return v, key
    return None


def session_by_uuid(uuid: str, cwd: str) -> Optional[dict]:
    """Locate a KNOWN uuid across every source, flat ones included.

    Not cwd-scoped: the id came from the host, so it is already the right session, and
    Codex rollouts live in a date tree that no cwd encoding can address.
    """
    for root in live_roots():
        for dirpath, _dirnames, filenames in os.walk(root):
            for f in filenames:
                if not f.endswith(".jsonl") or uuid not in f:
                    continue
                path = os.path.join(dirpath, f)
                st = _stat(path)
                if not st:
                    continue
                meta = _peek(path)
                return {"session_uuid": uuid, "project_dir": dirpath,
                        "cwd": meta["cwd"] or cwd, "title": meta["title"],
                        "mtime": st[0], "age_sec": age(st[0]),
                        # about the CWD claim, not the id: false when the transcript
                        # recorded none and the caller's directory was substituted
                        "confident": meta["cwd"] is not None}
    return None


def current_session(cwd: Optional[str] = None) -> Optional[dict]:
    """Which session am I in — the host's env first, then the cwd scan."""
    cwd = cwd or os.getcwd()
    # Ask the host first. Only trusted when the id resolves to a transcript on disk: an
    # env var is proof of intent, not of a file, and this reports paths.
    env = session_id_from_env()
    if env:
        hit = session_by_uuid(env[0], cwd)
        if hit:
            return hit
    best = None
    for root in live_roots():
        for project in _dirs(root):
            pdir = os.path.join(root, project)
            for f in _files(pdir):
                p = os.path.join(pdir, f)
                meta = _peek(p)
                if meta["cwd"] != cwd:
                    continue
                st = _stat(p)
                if not st:
                    continue
                if best is None or st[0] > best["mtime"]:
                    best = {"session_uuid": f[:-6], "project_dir": pdir, "cwd": meta["cwd"],
                            "title": meta["title"], "mtime": st[0], "age_sec": age(st[0])}
    return best
