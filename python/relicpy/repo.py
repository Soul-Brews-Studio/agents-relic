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


def ghq_root() -> str:
    """ghq root differs per machine — m5 is /opt/Code, others vary."""
    return os.environ.get("GHQ_ROOT") or str(_HOME / "ghq")


def default_root() -> str:
    return os.environ.get("RELIC_DATA_ROOT") or str(_HOME / SHARD_DIR)


def repo_key_of(cwd: Optional[str]) -> Optional[str]:
    """A cwd to "github.com/<org>/<repo>", or None.

    HOST-INDEPENDENT ON PURPOSE. The same repo checked out on three machines under
    three different roots is ONE shard, not three, because the key is taken from the
    path's own github.com/<org>/<repo> segment rather than from where it was mounted.
    Worktrees under <repo>/wt/<slug> fold into the repo they belong to.
    """
    if not cwd:
        return None
    m = re.search(r"(github\.com/[^/]+/[^/]+)", cwd)
    if not m:
        return None
    key = m.group(1)
    # A worktree is not a different repo.
    return key


def context_of(cwd: Optional[str]) -> dict[str, str]:
    """The worktree slug, when the path has one."""
    if not cwd:
        return {"worktree": ""}
    m = re.search(r"/wt/([^/]+)", cwd)
    return {"worktree": m.group(1) if m else ""}


def location_of(cwd: Optional[str]) -> dict[str, str]:
    """org / project / dir facets, for filtering without a full path match."""
    if not cwd:
        return {"org": "", "project": "", "dir": ""}
    m = re.search(r"github\.com/([^/]+)/([^/]+)", cwd)
    org, project = (m.group(1), m.group(2)) if m else ("", "")
    return {"org": org, "project": project, "dir": os.path.basename(cwd.rstrip("/"))}


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
