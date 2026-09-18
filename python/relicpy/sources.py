"""Where transcripts live on this machine, and how to read each shape.

The registry, not the walker. Adding an agent should mean adding an entry here, not
editing discover.py — that separation is why `walk` and `shape` are independent knobs.

Mirrors src/sources.ts entry for entry, including which are OFF by default. A source
that differs between the two implementations would make `relic pending` disagree with
itself about what is missing.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from typing import Callable, Literal, Optional

from .models import ParsedFile
from .repo import ghq_root
from .shapes import claude as shape_claude
from .shapes import codex as shape_codex
from .shapes import memory as shape_memory
from .shapes import omp as shape_omp
from .shapes import vault as shape_vault

HOME = os.path.expanduser("~")

Walk = Literal["claude-tiers", "flat", "omp", "vault", "vaults", "hermes", "memory"]
Parser = Callable[[str], ParsedFile]


@dataclass
class SourceDef:
    key: str
    path: str
    walk: str
    parser: Parser
    enabled: bool
    note: str
    bank: Optional[str] = None


def bank_of(s: SourceDef) -> str:
    """The bank a source writes. Defaults to the key, so a new source is isolated
    until someone deliberately shares a bank with an existing one."""
    return s.bank or s.key


def _builtin() -> list[SourceDef]:
    return [
        SourceDef("claude-live", os.path.join(HOME, ".claude", "projects"),
                  "claude-tiers", shape_claude.parse, True,
                  "Claude Code — session / subagent / workflow_agent", "projects"),
        SourceDef("claude-archive", os.path.join(HOME, ".claude", "projects-archive"),
                  "claude-tiers", shape_claude.parse, True,
                  "Claude Code archive", "projects-archive"),
        SourceDef("claude-1sep", os.path.join(HOME, ".claude", "projects-1sep-tue2026"),
                  "claude-tiers", shape_claude.parse, True,
                  "Claude Code snapshot 1sep-tue2026 — the largest root",
                  "projects-1sep-tue2026"),
        SourceDef("codex", os.path.join(HOME, ".codex", "sessions"),
                  "flat", shape_codex.parse, True, "Codex CLI rollouts"),
        SourceDef("omp", os.path.join(HOME, ".omp", "agent", "sessions"),
                  "omp", shape_omp.parse, True,
                  "omp — one dir per encoded cwd, flat <timestamp>_<id>.jsonl inside"),
        SourceDef("oracle-vault", os.path.join(HOME, ".relic-vault-unset"),
                  "vault", shape_vault.parse, False,
                  "ONE oracle's ψ vault — set its path in ~/.relic/sources.json", "vault"),
        SourceDef("oracle-vaults", os.path.join(ghq_root(), "github.com"),
                  "vaults", shape_vault.parse, False,
                  "EVERY <org>/<repo>/ψ under the ghq tree — symlinks resolved, realpath-deduped",
                  "vaults"),
        SourceDef("claude-memory", os.path.join(HOME, ".claude", "projects"),
                  "memory", shape_memory.parse, True,
                  "Claude Code memory — typed facts (project/feedback/reference/user)",
                  "memory"),
        SourceDef("hermes", os.path.join(HOME, ".hermes"),
                  "hermes", shape_claude.parse, False,
                  "Hermes — SQLite state.db per profile (not ported to Python yet)"),
        SourceDef("omx-logs", os.path.join(HOME, ".omx-runs"),
                  "flat", shape_claude.parse, False,
                  "omx run logs — OPS LOGS, not conversation. Opt in only if you want them."),
    ]


_SHAPES: dict[str, Parser] = {
    "claude": shape_claude.parse, "codex": shape_codex.parse,
    "vault": shape_vault.parse, "omp": shape_omp.parse, "memory": shape_memory.parse,
}


def load_sources() -> list[SourceDef]:
    """Builtins, overlaid with ~/.relic/sources.json — the SAME file the TypeScript
    reads, so both front ends agree about what exists."""
    out = list(_builtin())
    cfg_path = os.path.join(HOME, ".relic", "sources.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as fh:
                cfg = json.load(fh)
            for k in cfg.get("disable", []):
                for s in out:
                    if s.key == k:
                        s.enabled = False
            for k in cfg.get("enable", []):
                for s in out:
                    if s.key == k:
                        s.enabled = True
            # Let config point a builtin at a real path — the vault's location is
            # per-machine, so its builtin ships with a placeholder and MUST be
            # repointed here. Setting a path also enables the source.
            for k, v in (cfg.get("path") or {}).items():
                for s in out:
                    if s.key == k and isinstance(v, str):
                        s.path = v
                        s.enabled = True
            for a in cfg.get("add", []):
                walk = a.get("walk")
                walk = walk if walk in ("claude-tiers", "vault", "vaults", "omp", "memory", "hermes") else "flat"
                out.append(SourceDef(
                    key=str(a["key"]), path=str(a["path"]), walk=walk,
                    # walk and shape are INDEPENDENT knobs and both must be mapped
                    # explicitly. Defaulting shape to claude while accepting
                    # walk:"vault" would walk a vault correctly and then parse every
                    # note with the transcript parser — zero events per file, which
                    # looks exactly like an empty vault.
                    parser=_SHAPES.get(a.get("shape"), shape_claude.parse),
                    enabled=a.get("enabled") is not False,
                    note=str(a.get("note", "user-configured")),
                    bank=str(a["bank"]) if a.get("bank") else None,
                ))
        except Exception:
            pass          # a broken config must not stop an index run

    # A DUPLICATE SOURCE IS A DOUBLED BANK, and nothing downstream would say so.
    seen_keys: set[str] = set()
    seen_banks: set[str] = set()
    kept: list[SourceDef] = []
    for s in out:
        b = bank_of(s)
        if s.key in seen_keys or b in seen_banks:
            print(f"  relic: dropping duplicate source {s.key} "
                  f"(bank already taken — check ~/.relic/sources.json)", file=sys.stderr)
            continue
        seen_keys.add(s.key)
        seen_banks.add(b)
        kept.append(s)
    return kept


def source_keys() -> list[str]:
    return [s.key for s in load_sources()]
