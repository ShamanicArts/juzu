import type { CommitNode, LayoutMode, LayoutResult, GraphConfig } from "./types";
import { UI_TOKENS } from "./ui-tokens";
import { getRuntimeConfig } from "./runtime-config";

const DEFAULT_CONFIG: GraphConfig = {
  nodeRadius: getRuntimeConfig().visual.nodeRadius,
  laneWidth: getRuntimeConfig().visual.laneWidth,
  ySpacing: getRuntimeConfig().visual.ySpacing,
  canvasPadding: getRuntimeConfig().visual.canvasPadding,
  textColumnGap: getRuntimeConfig().visual.textColumnGap,
  colors: {
    node: UI_TOKENS.graph.node,
    nodeSelected: UI_TOKENS.graph.nodeSelected,
    nodeConflict: UI_TOKENS.graph.nodeConflict,
    text: UI_TOKENS.graph.text,
    textDesc: UI_TOKENS.graph.textDesc,
    nodeBorder: UI_TOKENS.graph.nodeBorder,
    lanes: [...UI_TOKENS.graph.lanes],
  },
};

function buildChildrenById(nodes: CommitNode[]): Map<string, CommitNode[]> {
  const childrenById = new Map<string, CommitNode[]>();
  for (let i = 0; i < nodes.length; i++) {
    const child = nodes[i]!;
    for (let p = 0; p < child.parents.length; p++) {
      const parentId = child.parents[p]!;
      const arr = childrenById.get(parentId);
      if (arr) arr.push(child);
      else childrenById.set(parentId, [child]);
    }
  }
  return childrenById;
}

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
  const childrenById = buildChildrenById(nodes);
  const visited = new Set<string>();
  const queue: Array<[CommitNode, number]> = [[wc, 0]];

  for (let qi = 0; qi < queue.length; qi++) {
    const [node, lane] = queue[qi]!;
    if (visited.has(node.changeId)) continue;
    visited.add(node.changeId);

    node.lane = Math.abs(lane);

    node.parents.forEach((parentId, idx) => {
      const parent = nodesMap.get(parentId);
      if (parent && !visited.has(parentId)) queue.push([parent, lane + 1 + idx]);
    });

    const children = childrenById.get(node.changeId);
    if (children) {
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (!visited.has(child.changeId)) queue.push([child, lane - 1]);
      }
    }
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

function layoutMainline(
  nodes: CommitNode[],
  nodesMap: Map<string, CommitNode>,
  cfg: Pick<GraphConfig, "ySpacing" | "canvasPadding">
) {
  // First pass: calculate Y positions (chronological order) for lane collision detection
  const Y_SPACING = cfg.ySpacing;
  const CANVAS_PADDING = cfg.canvasPadding;
  let currentY = CANVAS_PADDING;
  nodes.forEach((node) => {
    node.y = currentY;
    currentY += Y_SPACING + (node.extraHeight || 0);
  });

  // Find heads (nodes with no children)
  const childrenById = buildChildrenById(nodes);
  const heads = nodes.filter((n) => !childrenById.has(n.changeId));

  // Build mainline: find longest/best path from any head to root
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

  // Mainline nodes get lane 0
  const mainlineSet = new Set(bestPath.map((n) => n.changeId));
  bestPath.forEach((n) => (n.lane = 0));

  // Track Y ranges occupied in each lane (lane -> array of [minY, maxY] ranges)
  const laneRanges = new Map<number, [number, number][]>();
  laneRanges.set(0, [[0, 999999]]); // Mainline occupies everything

  // Helper to check if a lane is available at a given Y position
  const isLaneAvailable = (lane: number, y: number, height: number = Y_SPACING): boolean => {
    const ranges = laneRanges.get(lane);
    if (!ranges) return true;

    // Ensure minimum height for collision detection (single commits need this)
    const effectiveHeight = Math.max(height, Y_SPACING);

    // Check if this Y range overlaps with any existing range
    for (const [minY, maxY] of ranges) {
      // Add some padding between branches - use >= to catch edge cases
      if (y <= maxY + Y_SPACING && y + effectiveHeight >= minY - Y_SPACING) {
        return false; // Overlaps
      }
    }
    return true;
  };

  // Helper to occupy a lane range
  const occupyLane = (lane: number, minY: number, maxY: number) => {
    if (!laneRanges.has(lane)) {
      laneRanges.set(lane, []);
    }
    laneRanges.get(lane)!.push([minY, maxY]);
  };

  // Group commits by "branch" (connected component off mainline)
  const branchCommits = new Map<string, CommitNode[]>(); // root changeId -> commits in branch

  // Find branch roots (commits that have a mainline parent but aren't on mainline)
  nodes.forEach((node) => {
    if (mainlineSet.has(node.changeId)) return;

    const hasMainlineParent = node.parents.some((pid) => mainlineSet.has(pid));
    if (hasMainlineParent) {
      // This is a branch root
      branchCommits.set(node.changeId, [node]);
    }
  });

  // Grow each branch to include all descendants until they hit mainline or another branch
  branchCommits.forEach((commits, rootId) => {
    const branchSet = new Set<string>(commits.map((c) => c.changeId));

    // Use a queue to find all descendants
    const toProcess = [...commits];
    while (toProcess.length > 0) {
      const current = toProcess.shift()!;

      const children = childrenById.get(current.changeId);
      if (!children) continue;
      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        if (branchSet.has(child.changeId)) continue;
        if (mainlineSet.has(child.changeId)) continue;
        branchSet.add(child.changeId);
        commits.push(child);
        toProcess.push(child);
      }
    }

    // Sort commits by Y position
    commits.sort((a, b) => a.y! - b.y!);
  });

  // Assign lanes to branches, reusing lanes when vertically separated
  // CRITICAL: Extend lane occupation to the mainline parent to prevent overlapping connections
  branchCommits.forEach((commits, rootId) => {
    if (commits.length === 0) return;

    const minY = commits[0].y!;
    let maxY = commits[commits.length - 1].y!;

    // Find the mainline parent's Y position - need to extend occupation to there
    // to prevent overlapping connection lines for parallel branches
    const branchRoot = commits.find(c => c.changeId === rootId);
    if (branchRoot) {
      for (const parentId of branchRoot.parents) {
        const parent = nodesMap.get(parentId);
        if (parent && mainlineSet.has(parentId) && parent.y !== undefined) {
          // Extend maxY to the parent's Y so connection lines don't overlap
          maxY = Math.max(maxY, parent.y);
          break;
        }
      }
    }

    // Find the nearest available lane to mainline
    let lane = 1;
    while (!isLaneAvailable(lane, minY, maxY - minY)) {
      lane++;
    }

    // Assign this lane to all commits in the branch
    commits.forEach((node) => {
      node.lane = lane;
    });

    // Mark lane as occupied
    occupyLane(lane, minY, maxY);
  });

  // Handle any remaining unassigned commits (merges, orphans, etc.)
  nodes.forEach((node) => {
    if (node.lane !== undefined) return;

    // Find parent lane
    let parentLane: number | undefined;
    for (const parentId of node.parents) {
      const parent = nodesMap.get(parentId);
      if (parent && parent.lane !== undefined) {
        parentLane = parent.lane;
        if (!mainlineSet.has(parentId)) break;
      }
    }

    if (parentLane !== undefined && parentLane !== 0) {
      // Try to use parent's lane if available at this Y
      if (isLaneAvailable(parentLane, node.y!)) {
        node.lane = parentLane;
        occupyLane(parentLane, node.y!, node.y! + Y_SPACING);
      } else {
        // Find nearest available
        let lane = 1;
        while (!isLaneAvailable(lane, node.y!)) {
          lane++;
        }
        node.lane = lane;
        occupyLane(lane, node.y!, node.y! + Y_SPACING);
      }
    } else {
      // Orphaned - find nearest available lane
      let lane = 1;
      while (!isLaneAvailable(lane, node.y!)) {
        lane++;
      }
      node.lane = lane;
      occupyLane(lane, node.y!, node.y! + Y_SPACING);
    }
  });
}

/**
 * Apply layout algorithm and calculate coordinates
 * Returns nodes with x, y positions and metadata for rendering
 */
export function calculateLayout(
  mode: LayoutMode,
  nodes: CommitNode[],
  config: Partial<GraphConfig> = {},
  pinnedNodes?: Map<string, number>
): LayoutResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  // Shallow-copy nodes but reuse the same object shape to reduce allocation pressure.
  // Pre-set layout fields so layout functions can assign directly.
  const nodesCopy: CommitNode[] = new Array(nodes.length);
  const nodesMap = new Map<string, CommitNode>();
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const copy: CommitNode = {
      changeId: n.changeId,
      commitId: n.commitId,
      parents: n.parents,
      author: n.author,
      time: n.time,
      bookmarks: n.bookmarks,
      gitBranches: n.gitBranches,
      descriptionTitle: n.descriptionTitle,
      descriptionFull: n.descriptionFull,
      isEmpty: n.isEmpty,
      isConflict: n.isConflict,
      isHidden: n.isHidden,
      isRoot: n.isRoot,
      isWorkingCopy: n.isWorkingCopy,
      lane: undefined,
      x: undefined,
      y: undefined,
      extraHeight: n.extraHeight,
      isPinned: false,
    };
    nodesCopy[i] = copy;
    nodesMap.set(copy.changeId, copy);
  }

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
      layoutMainline(nodesCopy, nodesMap, cfg);
      break;
  }

  if (pinnedNodes && pinnedNodes.size > 0) {
    for (let i = 0; i < nodesCopy.length; i++) {
      const node = nodesCopy[i]!;
      const pinnedLane = pinnedNodes.get(node.changeId);
      if (pinnedLane === undefined) continue;
      node.lane = Math.max(0, Math.floor(pinnedLane));
      node.isPinned = true;
    }
  }

  // Calculate coordinates
  for (let i = 0; i < nodesCopy.length; i++) {
    if (nodesCopy[i]!.lane === undefined) nodesCopy[i]!.lane = 0;
  }

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
 * Get lane color based on index - uses current UI_TOKENS for live theme updates
 */
export function getLaneColor(index: number, config: Partial<GraphConfig> = {}): string {
  // Always use current UI_TOKENS lanes so theme changes apply immediately
  const lanes = UI_TOKENS.graph.lanes;
  return lanes[index % lanes.length];
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
  const thresholdSq = threshold * threshold;
  const nodesById = new Map<string, CommitNode>();
  for (let i = 0; i < nodes.length; i++) nodesById.set(nodes[i]!.changeId, nodes[i]!);

  for (const node of nodes) {
    for (const parentId of node.parents) {
      const parent = nodesById.get(parentId);
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
      if (dx * dx + dy * dy < thresholdSq) {
        return { from: parent, to: node };
      }
    }
  }
  return null;
}
