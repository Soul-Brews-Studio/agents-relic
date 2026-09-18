/**
 * Path trees — the SHAPE of a set of files, not just the list.
 *
 * Lives apart from cli.ts because cli.ts runs a command at import time: anything that
 * imported it to reuse one function would execute the CLI as a side effect. Same
 * reason query.ts exists.
 *
 * A leaf carries an opaque `label` rather than a fixed set of columns, because the two
 * callers describe different things — an indexed transcript has an event count, a
 * PENDING file does not exist in the index at all and has a state and a size instead.
 * Baking one caller's columns into the renderer would have meant a second renderer.
 */

const fmt = (n: number) => n.toLocaleString("en-US");

export interface TreeEntry {
  path: string;     // relative to whatever root the caller prints above the tree
  label: string;    // rendered after the filename
  weight?: number;  // summed up the directories; events, bytes, whatever the caller means
}

export interface TreeNode {
  children: Map<string, TreeNode>;
  leaf?: { label: string };
  weight: number;
  files: number;
}

function newNode(): TreeNode { return { children: new Map(), weight: 0, files: 0 }; }

export function buildTree(entries: TreeEntry[]): TreeNode {
  const root = newNode();
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    const w = e.weight ?? 0;
    let node = root;
    root.weight += w; root.files++;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let child = node.children.get(name);
      if (!child) { child = newNode(); node.children.set(name, child); }
      child.weight += w;
      child.files++;
      if (i === parts.length - 1) child.leaf = { label: e.label };
      node = child;
    }
  }
  return root;
}

/**
 * Directories first, then files, each group biggest first.
 *
 * A run directory is the thing the reader is looking for; burying it under twenty
 * sibling transcripts defeats the point of drawing a tree at all.
 */
export function renderTree(
  node: TreeNode,
  prefix = "",
  limitPerDir = 8,
  emit: (line: string) => void = console.log,
  unit = "ev",
): void {
  const kids = [...node.children.entries()];
  kids.sort((a, b) => {
    const ad = a[1].children.size > 0, bd = b[1].children.size > 0;
    if (ad !== bd) return ad ? -1 : 1;
    return b[1].weight - a[1].weight;
  });
  const shown = kids.slice(0, limitPerDir);
  const hidden = kids.length - shown.length;
  shown.forEach(([name, child], i) => {
    const last = i === shown.length - 1 && hidden === 0;
    const branch = last ? "└── " : "├── ";
    if (child.children.size > 0) {
      const n = child.files;
      const w = child.weight ? `, ${fmt(child.weight)} ${unit}` : "";
      emit(`${prefix}${branch}${name}/   (${n} file${n === 1 ? "" : "s"}${w})`);
      renderTree(child, prefix + (last ? "    " : "│   "), limitPerDir, emit, unit);
    } else {
      emit(`${prefix}${branch}${name}   ${child.leaf!.label}`);
    }
  });
  if (hidden > 0) emit(`${prefix}└── ... and ${hidden} more`);
}

/** The longest directory prefix every path shares — what to print above the tree. */
export function commonPrefix(paths: string[]): string {
  if (!paths.length) return "";
  const split = paths.map(p => p.split("/"));
  const first = split[0];
  let i = 0;
  while (i < first.length - 1 && split.every(p => p[i] === first[i])) i++;
  return first.slice(0, i).join("/") + "/";
}
