"""Path trees — the SHAPE of a set of files, not just the list.

A leaf carries an opaque `label` rather than fixed columns, because the callers
describe different things: an indexed transcript has an event count, a PENDING file
does not exist in the index and has a state and a size.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Optional


@dataclass
class TreeNode:
    children: dict[str, "TreeNode"] = field(default_factory=dict)
    label: Optional[str] = None
    weight: int = 0
    files: int = 0


def build_tree(entries: list[dict]) -> TreeNode:
    root = TreeNode()
    for e in entries:
        parts = [p for p in e["path"].split("/") if p]
        w = int(e.get("weight") or 0)
        node = root
        root.weight += w
        root.files += 1
        for i, name in enumerate(parts):
            child = node.children.get(name)
            if child is None:
                child = TreeNode()
                node.children[name] = child
            child.weight += w
            child.files += 1
            if i == len(parts) - 1:
                child.label = e["label"]
            node = child
    return root


def render_tree(node: TreeNode, prefix: str = "", limit_per_dir: int = 8,
                emit: Callable[[str], None] = print, unit: str = "ev") -> None:
    """Directories first, then files, each group biggest first.

    A run directory is what the reader is looking for; burying it under twenty sibling
    transcripts defeats the point of drawing a tree.
    """
    kids = sorted(node.children.items(),
                  key=lambda kv: (0 if kv[1].children else 1, -kv[1].weight))
    shown, hidden = kids[:limit_per_dir], len(kids) - min(len(kids), limit_per_dir)
    for i, (name, child) in enumerate(shown):
        last = i == len(shown) - 1 and hidden == 0
        branch = "└── " if last else "├── "
        if child.children:
            w = f", {child.weight:,} {unit}" if child.weight else ""
            emit(f"{prefix}{branch}{name}/   ({child.files} file{'' if child.files == 1 else 's'}{w})")
            render_tree(child, prefix + ("    " if last else "│   "), limit_per_dir, emit, unit)
        else:
            emit(f"{prefix}{branch}{name}   {child.label}")
    if hidden > 0:
        emit(f"{prefix}└── ... and {hidden} more")


def common_prefix(paths: list[str]) -> str:
    """The longest directory prefix every path shares — what to print above the tree."""
    if not paths:
        return ""
    split = [p.split("/") for p in paths]
    first = split[0]
    i = 0
    while i < len(first) - 1 and all(len(p) > i and p[i] == first[i] for p in split):
        i += 1
    return "/".join(first[:i]) + "/"
