"""What is running RIGHT NOW — answered from the filesystem, never from the index.

The index is always behind live work by definition: a transcript is appended to while
it is read, and an import that just ran cannot include the line written a second later.
So liveness here is mtime, which is exactly as fresh as the work itself.
"""

from __future__ import annotations

import json
import os
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


def current_session(cwd: Optional[str] = None) -> Optional[dict]:
    """Which session am I in — resolved from the cwd, newest transcript wins."""
    cwd = cwd or os.getcwd()
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
