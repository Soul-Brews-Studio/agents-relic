/**
 * Path trees — the SHAPE of a session, not just its contents.
 *
 * Lives apart from cli.ts because cli.ts runs a command at import time: anything that
 * imported it to reuse one function would execute the CLI as a side effect. Same
 * reason query.ts exists.
 */

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * A session tree, rendered as a tree.
 *
 * The flat listing answers "which transcripts" but hides the SHAPE, and the shape is
 * the interesting part: a workflow run is a directory holding one transcript per
 * agent, so nine agents working in parallel look identical to nine sequential ones
 * until you can see they share a `wf_<run>/` parent.
 *
 * Directories are summarised rather than just drawn — a run line carries its agent
 * count and event total, because "wf_3ae64b4d-526 (9 agents, 41,551 ev)" is the
 * sentence someone actually wants, and it is invisible in a flat list sorted by time.
 */
export interface TreeNode {
  children: Map<string, TreeNode>;
  leaf?: { tier: string; events: number; time: string };
  events: number;
  files: number;
}

function newNode(): TreeNode { return { children: new Map(), events: 0, files: 0 }; }

export function buildTree(entries: { path: string; tier: string; events: number; time: string }[]): TreeNode {
  const root = newNode();
  for (const e of entries) {
    const parts = e.path.split("/").filter(Boolean);
    let node = root;
    root.events += e.events; root.files++;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      let child = node.children.get(name);
      if (!child) { child = newNode(); node.children.set(name, child); }
      child.events += e.events;
      child.files++;
      if (i === parts.length - 1) child.leaf = { tier: e.tier, events: e.events, time: e.time };
      node = child;
    }
  }
  return root;
}

export function renderTree(node: TreeNode, prefix = "", limitPerDir = 8,
                           emit: (line: string) => void = console.log): void {
  const kids = [...node.children.entries()];
  // Directories first, then files — a run directory is the thing you are looking for,
  // and burying it under twenty sibling transcripts defeats the point of a tree.
  kids.sort((a, b) => {
    const ad = a[1].children.size > 0, bd = b[1].children.size > 0;
    if (ad !== bd) return ad ? -1 : 1;
    return b[1].events - a[1].events;
  });
  const shown = kids.slice(0, limitPerDir);
  const hidden = kids.length - shown.length;
  shown.forEach(([name, child], i) => {
    const last = i === shown.length - 1 && hidden === 0;
    const branch = last ? "└── " : "├── ";
    const isDir = child.children.size > 0;
    if (isDir) {
      const agents = child.files;
      emit(`${prefix}${branch}${name}/   (${agents} file${agents === 1 ? "" : "s"}, ${fmt(child.events)} ev)`);
      renderTree(child, prefix + (last ? "    " : "│   "), limitPerDir, emit);
    } else {
      const l = child.leaf!;
      emit(`${prefix}${branch}${name}   ${l.time} ${l.tier} ${fmt(l.events)} ev`);
    }
  });
  if (hidden > 0) emit(`${prefix}└── ... and ${hidden} more`);
}

