import type { CommitNode, LayoutMode, LayoutResult, GraphConfig } from "./types";

const DEFAULT_CONFIG: GraphConfig = {
  nodeRadius: 5,
  laneWidth: 24,
  ySpacing: 45,
  canvasPadding: 50,
  textColumnGap: 60,
  colors: {
    node: "#444",
    nodeSelected: "#ffffff",
    nodeConflict: "#ff0055",
    text: "#888",
    textDesc: "#bbb",
    nodeBorder: "#666",
    lanes: [
      "#00f0ff",
      "#ff0055",
      "#00ff9d",
      "#ffaa00",
      "#aa00ff",
      "#00aaff",
      "#ffff00",
      "#ff00aa",
    ],
  },
};

function layoutChronological(nodes: CommitNode[], nodesMap: Map<string, CommitNode>) {
  const nodeLanes = new Map<string, number>();
  let nextFreeLane = 0;

  nodes.forEach((node) => {
    if (!nodeLanes.has(node.changeId)) nodeLanes.set(node.changeId, nextFreeLane++);
    const myLane = nodeLanes.get(node.changeId)!;
    node.lane = myLane;

    node.parents.forEach((parentId, idx) => {
      const parent = nodesMap.get(parentId);
      if (!parent) return;

      if (!nodeLanes.has(parentId)) {
        if (idx === 0) nodeLanes.set(parentId, myLane);
        else nodeLanes.set(parentId, nextFreeLane++);
      }
    });
  });
}

function layoutBookmarkCentric(nodes: CommitNode[], nodesMap: Map<string, CommitNode>) {
  const bookmarkLanes = new Map<string, number>();
  let nextLane = 0;

  nodes.forEach((node) => {
    if (node.bookmarks.length > 0) {
      const primary = node.bookmarks[0];
      if (!bookmarkLanes.has(primary)) bookmarkLanes.set(primary, nextLane++);
      node.lane = bookmarkLanes.get(primary)!;
    }
  });

  nodes.forEach((node) => {
    if (node.lane !== undefined) return;
    for (const parentId of node.parents) {
      const parent = nodesMap.get(parentId);
      if (parent && parent.lane !== undefined) {
        node.lane = parent.lane;
        break;
      }
    }
    if (node.lane === undefined) node.lane = nextLane++;
  });
}

function layoutWcFocused(nodes: CommitNode[], nodesMap: Map<string, CommitNode>) {
  const wc = nodes.find((n) => n.isWorkingCopy);
  if (!wc) {
    layoutChronological(nodes, nodesMap);
    return;
  }

  wc.lane = 0;
  const visited = new Set<string>();
  const queue: Array<[CommitNode, number]> = [[wc, 0]];

  while (queue.length > 0) {
    const [node, lane] = queue.shift()!;
    if (visited.has(node.changeId)) continue;
    visited.add(node.changeId);

    node.lane = Math.abs(lane);

    node.parents.forEach((parentId, idx) => {
      const parent = nodesMap.get(parentId);
      if (parent && !visited.has(parentId)) queue.push([parent, lane + 1 + idx]);
    });

    nodes.forEach((child) => {
      if (child.parents.includes(node.changeId) && !visited.has(child.changeId)) {
        queue.push([child, lane - 1]);
      }
    });
  }

  let maxLane = Math.max(...nodes.map((n) => n.lane || 0));
  nodes.forEach((node) => {
    if (node.lane === undefined) node.lane = ++maxLane;
  });
}

function layoutTopological(nodes: CommitNode[]) {
  const depths = new Map<string, number>();
  const roots = nodes.filter((n) => n.isRoot || n.parents.length === 0);
  roots.forEach((r) => depths.set(r.changeId, 0));

  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (depths.has(node.changeId)) continue;
    let maxParentDepth = -1;
    node.parents.forEach((parentId) => {
      const parentDepth = depths.get(parentId);
      if (parentDepth !== undefined) maxParentDepth = Math.max(maxParentDepth, parentDepth);
    });
    depths.set(node.changeId, maxParentDepth + 1);
  }

  nodes.forEach((node) => {
    node.lane = depths.get(node.changeId) || 0;
  });
}

function layoutMainline(nodes: CommitNode[], nodesMap: Map<string, CommitNode>) {
  const hasChildren = new Set<string>();
  nodes.forEach((n) => n.parents.forEach((p) => hasChildren.add(p)));
  const heads = nodes.filter((n) => !hasChildren.has(n.changeId));

  let bestPath: CommitNode[] = [];
  let bestScore = -1;

  for (const head of heads) {
    const path: CommitNode[] = [];
    let current: CommitNode | undefined = head;
    let score = 0;
    while (current) {
      path.push(current);
      if (current.isWorkingCopy) score += 200;
      if (current.bookmarks.includes("main") || current.bookmarks.includes("master")) score += 150;
      if (current.bookmarks.length > 0) score += 50;
      score += 1;
      current = current.parents.length > 0 ? nodesMap.get(current.parents[0]) : undefined;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPath = path;
    }
  }

  const mainlineSet = new Set(bestPath.map((n) => n.changeId));
  bestPath.forEach((n) => (n.lane = 0));

  const lanes = new Map<string, number>();
  nodes.forEach((node) => {
    if (mainlineSet.has(node.changeId)) {
      lanes.set(node.changeId, 0);
      node.lane = 0;
      return;
    }
    let parentLane: number | undefined;
    for (const parentId of node.parents) {
      if (lanes.has(parentId)) {
        parentLane = lanes.get(parentId);
        break;
      }
    }
    node.lane = parentLane !== undefined ? parentLane + 1 : 1;
    lanes.set(node.changeId, node.lane);
  });
}

/**
 * Apply layout algorithm and calculate coordinates
 * Returns nodes with x, y positions and metadata for rendering
 */
export function calculateLayout(
  mode: LayoutMode,
  nodes: CommitNode[],
  config: Partial<GraphConfig> = {}
): LayoutResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const nodesCopy = nodes.map((n) => ({ ...n }));
  const nodesMap = new Map(nodesCopy.map((n) => [n.changeId, n]));

  // Apply lane assignment based on mode
  switch (mode) {
    case "chronological":
      layoutChronological(nodesCopy, nodesMap);
      break;
    case "bookmark-centric":
      layoutBookmarkCentric(nodesCopy, nodesMap);
      break;
    case "wc-focused":
      layoutWcFocused(nodesCopy, nodesMap);
      break;
    case "topological":
      layoutTopological(nodesCopy);
      break;
    case "mainline":
      layoutMainline(nodesCopy, nodesMap);
      break;
  }

  // Calculate coordinates
  const maxLane = Math.max(0, ...nodesCopy.map((n) => n.lane || 0));
  const graphWidth = (maxLane + 1) * cfg.laneWidth;
  const textColumnX = cfg.canvasPadding + graphWidth + cfg.textColumnGap;

  let currentY = cfg.canvasPadding;
  nodesCopy.forEach((node) => {
    // Inverted X axis: Lane 0 (base) is rightmost
    node.x = cfg.canvasPadding + ((maxLane - (node.lane || 0)) * cfg.laneWidth);
    node.y = currentY;
    currentY += cfg.ySpacing + (node.extraHeight || 0);
  });

  return {
    nodes: nodesCopy,
    maxLane,
    textColumnX,
    totalHeight: currentY + cfg.canvasPadding,
  };
}

/**
 * Get lane color based on index
 */
export function getLaneColor(index: number, config: Partial<GraphConfig> = {}): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  return cfg.colors.lanes[index % cfg.colors.lanes.length];
}

/**
 * Find a node at given coordinates (for hit testing)
 */
export function findNodeAt(
  x: number,
  y: number,
  nodes: CommitNode[],
  config: Partial<GraphConfig> = {}
): CommitNode | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const threshold = cfg.nodeRadius * 3;

  for (const node of nodes) {
    if (node.x === undefined || node.y === undefined) continue;
    const dx = node.x - x;
    const dy = node.y - y;
    if (Math.sqrt(dx * dx + dy * dy) < threshold) {
      return node;
    }
  }
  return null;
}

/**
 * Find connection between nodes at given coordinates
 */
export function findConnectionAt(
  x: number,
  y: number,
  nodes: CommitNode[],
  config: Partial<GraphConfig> = {}
): { from: CommitNode; to: CommitNode } | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const threshold = 8;

  for (const node of nodes) {
    for (const parentId of node.parents) {
      const parent = nodes.find((n) => n.changeId === parentId);
      if (!parent || parent.x === undefined || parent.y === undefined || node.x === undefined || node.y === undefined) {
        continue;
      }

      const startX = node.x;
      const startY = node.y + cfg.nodeRadius + 4;
      const targetX = parent.x;
      const targetY = parent.y - cfg.nodeRadius - 4;
      const midX = (startX + targetX) / 2;
      const midY = (startY + targetY) / 2;

      const dx = x - midX;
      const dy = y - midY;
      if (Math.sqrt(dx * dx + dy * dy) < threshold) {
        return { from: parent, to: node };
      }
    }
  }
  return null;
}
