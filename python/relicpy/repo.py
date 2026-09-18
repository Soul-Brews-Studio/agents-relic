"""Where a row physically lives, and which repo it belongs to.

Two independent identities, and keeping them separate is the whole point:

  BANK  — which source root it came from. A property of the SOURCE.
  REPO  — which git repo it is about. Derived from the transcript's own cwd.

A shard is one (bank, repo) pair, and its path puts the bank first:

    ~/.relic/banks/<bank>/github.com/<org>/<repo>/
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

from .models import BANKS_DIR, DEFAULT_BANK, SHARD_DIR, Shard

_HOME = Path.home()


_cached_ghq_root: Optional[str] = None


def ghq_root() -> str:
    """ghq root differs per machine — ASK ghq, never guess.

    Defaulting to ~/ghq is wrong on this machine, where it is /opt/Code, and the
    failure is quiet: `relic-py sources` reported the oracle-vaults source as MISSING
    at a path that simply does not exist, which reads as "you have no vaults" rather
    than "this lookup is wrong". Mirrors src/repo.ts, including the cache — the
    subprocess is cheap but not free, and this is called per source.
    """
    global _cached_ghq_root
    if _cached_ghq_root:
        return _cached_ghq_root
    env = os.environ.get("GHQ_ROOT")
    if env:
        _cached_ghq_root = env
        return env
    try:
        import subprocess
        _cached_ghq_root = subprocess.run(["ghq", "root"], capture_output=True, text=True,
                                          timeout=10).stdout.strip() or "/opt/Code"
    except Exception:
        _cached_ghq_root = "/opt/Code"      # fleet default
    return _cached_ghq_root


def default_root() -> str:
    return os.environ.get("RELIC_DATA_ROOT") or str(_HOME / SHARD_DIR)


def _normalize_repo(seg: str) -> str:
    """Collapse SIBLING worktrees back into their repo — for SHARDING ONLY.

    Two conventions exist in this fleet. The current one nests worktrees inside the
    repo (`my-repo/wt/<slug>`); an older one puts them BESIDE it:

        github.com/acme/my-repo.wt-5-some-feature
        github.com/acme/my-repo.omx-worktrees

    Those are one repo and must share one shard — `--repo my-repo` produced 17 shards
    instead of 1 before this existed. Leaving it out of the Python port reproduced the
    bug in miniature: `homekeeper-oracle.wt-1-bridge` and `.wt-2-white` became two
    extra shards, so Python wrote 28 where the reference wrote 27.

    ONLY these exact markers are stripped. A dot is legal in a repo name, so a blanket
    "cut at the first dot" would mangle a genuinely-dotted repo.

    The worktree itself is NOT discarded — `context_of` keeps it as a searchable field,
    because which worktree a session ran in says what the work was about.
    """
    return re.sub(r"\.(wt-.*|omx-worktrees|worktrees)$", "", seg)


def repo_key_of(cwd: Optional[str]) -> Optional[str]:
    """A cwd to "github.com/<org>/<repo>", or None.

    HOST-INDEPENDENT ON PURPOSE. The same repo checked out under four different roots
    (/opt/Code, ~/ghq, a CI home, another account) is ONE shard, not four: find the
    `github.com/<org>/<repo>` triple ANYWHERE in the path and stop there. Everything
    deeper — worktrees under wt/, agents/, ψ/lab/... — belongs to the owning repo.
    """
    if not cwd:
        return None
    parts = [p for p in cwd.split("/") if p]

    if "github.com" in parts:
        gh = parts.index("github.com")
        if len(parts) >= gh + 3:
            return f"github.com/{parts[gh + 1]}/{_normalize_repo(parts[gh + 2])}"

    # incubate worktrees drop the host segment: .../incubate/worktrees/<org>/<repo>/...
    if "worktrees" in parts:
        wt = parts.index("worktrees")
        if wt > 0 and parts[wt - 1] == "incubate" and len(parts) >= wt + 3:
            return f"github.com/{parts[wt + 1]}/{_normalize_repo(parts[wt + 2])}"

    return None


# Containers whose NEXT segment names a distinct project living inside a repo.
PROJECT_CONTAINERS = {"lab", "soul-brews-studio", "learn", "demos"}

_SIBLING = re.compile(r"^.*?\.(wt-.*|omx-worktrees|worktrees)$")


def context_of(cwd: Optional[str]) -> dict[str, str]:
    """The context a session ran in, WITHIN its repo.

    Worth keeping and filtering on, because a worktree name is usually a statement of
    intent ("big-refactor-2026-09", "wt-5-some-feature"). Four conventions are
    recognised, and a naive "look for /wt/" implementation finds only one of them —
    which is what the first cut of this port did, leaving `agents/codex` and
    `lab/03-fb-stream-ego` as empty strings on 18 of 198 rows.
    """
    if not cwd:
        return {"worktree": "", "subpath": ""}
    parts = [p for p in cwd.split("/") if p]
    if "github.com" not in parts:
        return {"worktree": "", "subpath": ""}
    gh = parts.index("github.com")
    if len(parts) < gh + 3:
        return {"worktree": "", "subpath": ""}

    repo_seg = parts[gh + 2]
    rest = parts[gh + 3:]
    subpath = "/".join(rest)

    # sibling conventions carry the worktree in the repo segment itself
    sib = _SIBLING.match(repo_seg)
    if sib:
        marker = sib.group(1)
        if marker.startswith("wt-"):
            return {"worktree": marker, "subpath": subpath}
        return {"worktree": rest[0] if rest else marker, "subpath": subpath}

    if len(rest) > 1 and rest[0] == "wt":
        return {"worktree": rest[1], "subpath": subpath}
    if len(rest) > 1 and rest[0] == "agents":
        return {"worktree": f"agents/{rest[1]}", "subpath": subpath}
    if len(rest) > 2 and rest[0] == "\u03c8" and rest[1] == "lab":
        return {"worktree": f"lab/{rest[2]}", "subpath": subpath}

    return {"worktree": "", "subpath": subpath}


def location_of(cwd: Optional[str]) -> dict[str, str]:
    """org / repo / project / worktree / dir — the facets `--org --project --dir` use.

    `repo_key` fuses org+repo and drops the rest, which mis-attributes a nested vault
    or lab to its host repo. These columns are what let a query separate them.
    """
    empty = {"org": "", "repo": "", "project": "", "worktree": "", "dir": ""}
    if not cwd:
        return empty
    parts = [p for p in cwd.split("/") if p]
    if "github.com" not in parts:
        return empty
    gh = parts.index("github.com")
    if len(parts) < gh + 3:
        return empty

    ctx = context_of(cwd)
    worktree, subpath = ctx["worktree"], ctx["subpath"]
    seg = [x for x in subpath.split("/") if x]

    # Walk past the vault marker and any worktree segment to find a container.
    project = ""
    for i in range(max(0, len(seg) - 1)):
        if seg[i] in PROJECT_CONTAINERS:
            project = seg[i + 1]
            break
        # ψ/incubate/<org>/<repo> — the INCUBATED repo is the project, not the org
        if seg[i] == "incubate" and i + 2 < len(seg):
            project = seg[i + 2]
            break

    # `dir` is the DIRECTORY below the worktree — not below the repo, and not including
    # the filename. Leaving the worktree in duplicates a facet that has its own column;
    # leaving the filename in makes `--dir` match one file instead of a tree.
    d = subpath
    for p in (f"wt/{worktree}/", f"agents/{worktree}/"):
        if worktree and d.startswith(p):
            d = d[len(p):]
            break
    slash = d.rfind("/")
    d = d[:slash] if slash > 0 else ""

    return {
        "org": parts[gh + 1] if len(parts) > gh + 1 else "",
        "repo": _normalize_repo(parts[gh + 2]) if len(parts) > gh + 2 else "",
        "project": project, "worktree": worktree, "dir": d,
    }


def shard_dir_for(
    repo_key: Optional[str],
    data_root: Optional[str] = None,
    in_repo: bool = False,
    bank: str = DEFAULT_BANK,
) -> str:
    """The directory one (bank, repo) pair writes to.

    BANK IS THE TOP LEVEL. Putting the repo first and the bank under it would scatter
    one bank across hundreds of directories, and `--bank` — the cheapest filter there
    is, because it cuts the shard set without knowing anything about the query — would
    have to walk all of them to answer.
    """
    key = repo_key or "_unresolved"
    b = bank or DEFAULT_BANK
    if data_root:
        return os.path.join(data_root, BANKS_DIR, b, key)
    if in_repo:
        if repo_key:
            return os.path.join(ghq_root(), repo_key, SHARD_DIR, BANKS_DIR, b)
        return os.path.join(ghq_root(), "_relic-unresolved", BANKS_DIR, b)
    return os.path.join(default_root(), BANKS_DIR, b, key)


def list_shards(data_root: Optional[str] = None, in_repo: bool = False) -> list[Shard]:
    """Every shard under the index root.

    Walks exactly three levels below `banks/`: <bank>/<host>/<org>/<repo>. Dot-prefixed
    directories AND `.lance` directories are skipped — LanceDB's own table directories
    live inside a shard and were briefly enumerated as if they were banks.
    """
    root = data_root or default_root()
    out: list[Shard] = []
    banks_root = os.path.join(root, BANKS_DIR)
    if not os.path.isdir(banks_root):
        return out
    for bank in _subdirs(banks_root):
        bank_dir = os.path.join(banks_root, bank)
        for host in _subdirs(bank_dir):
            host_dir = os.path.join(bank_dir, host)
            for org in _subdirs(host_dir):
                org_dir = os.path.join(host_dir, org)
                for repo in _subdirs(org_dir):
                    repo_path = f"{host}/{org}/{repo}"
                    out.append(Shard(
                        key=f"{bank}/{repo_path}",
                        dir=os.path.join(org_dir, repo),
                        bank=bank,
                        repo=repo_path,
                    ))
        # "_unresolved" sits directly under the bank, with no host/org/repo below it.
        unresolved = os.path.join(bank_dir, "_unresolved")
        if os.path.isdir(unresolved):
            out.append(Shard(key=f"{bank}/_unresolved", dir=unresolved,
                             bank=bank, repo="_unresolved"))
    return out


def banks(data_root: Optional[str] = None) -> list[str]:
    """The bank names on this machine. Never hardcode this list; it changes."""
    return sorted({s.bank for s in list_shards(data_root)})


def _subdirs(p: str) -> list[str]:
    try:
        return sorted(
            e.name for e in os.scandir(p)
            if e.is_dir() and not e.name.startswith(".") and not e.name.endswith(".lance")
        )
    except OSError:
        return []
