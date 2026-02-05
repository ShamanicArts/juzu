import type { CommitNode, LayoutMode } from "./types";

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
  if (!wc) return layoutChronological(nodes, nodesMap);

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
      if (child.parents.includes(node.changeId) && !visited.has(child.changeId)) queue.push([child, lane - 1]);
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
  // First pass: calculate Y positions for lane collision detection
  const Y_SPACING = 4; // TUI uses row-based spacing
  let currentY = 0;
  nodes.forEach((node) => {
    (node as any).rowY = currentY;
    currentY += Y_SPACING;
  });

  // Find heads (nodes with no children)
  const hasChildren = new Set<string>();
  nodes.forEach((n) => n.parents.forEach((p) => hasChildren.add(p)));
  const heads = nodes.filter((n) => !hasChildren.has(n.changeId));

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

  // Track Y ranges occupied in each lane
  const laneRanges = new Map<number, [number, number][]>();
  laneRanges.set(0, [[0, 999999]]); // Mainline occupies everything

  const isLaneAvailable = (lane: number, y: number, height: number = Y_SPACING): boolean => {
    const ranges = laneRanges.get(lane);
    if (!ranges) return true;
    // Ensure minimum height for collision detection
    const effectiveHeight = Math.max(height, Y_SPACING);
    for (const [minY, maxY] of ranges) {
      // Use >= to catch edge cases with adjacent commits
      if (y <= maxY + Y_SPACING && y + effectiveHeight >= minY - Y_SPACING) {
        return false;
      }
    }
    return true;
  };

  const occupyLane = (lane: number, minY: number, maxY: number) => {
    if (!laneRanges.has(lane)) {
      laneRanges.set(lane, []);
    }
    laneRanges.get(lane)!.push([minY, maxY]);
  };

  // Group commits by branch
  const branchCommits = new Map<string, CommitNode[]>();

  nodes.forEach((node) => {
    if (mainlineSet.has(node.changeId)) return;
    const hasMainlineParent = node.parents.some((pid) => mainlineSet.has(pid));
    if (hasMainlineParent) {
      branchCommits.set(node.changeId, [node]);
    }
  });

  // Grow branches
  branchCommits.forEach((commits, rootId) => {
    const branchSet = new Set<string>(commits.map((c) => c.changeId));
    const toProcess = [...commits];
    while (toProcess.length > 0) {
      const current = toProcess.shift()!;
      nodes.forEach((child) => {
        if (branchSet.has(child.changeId)) return;
        if (mainlineSet.has(child.changeId)) return;
        if (child.parents.includes(current.changeId)) {
          branchSet.add(child.changeId);
          commits.push(child);
          toProcess.push(child);
        }
      });
    }
    commits.sort((a, b) => (a as any).rowY - (b as any).rowY);
  });

  // Assign lanes with collision detection
  branchCommits.forEach((commits, rootId) => {
    if (commits.length === 0) return;
    const minY = (commits[0] as any).rowY;
    const maxY = (commits[commits.length - 1] as any).rowY;

    let lane = 1;
    while (!isLaneAvailable(lane, minY, maxY - minY)) {
      lane++;
    }

    commits.forEach((node) => {
      node.lane = lane;
    });
    occupyLane(lane, minY, maxY);
  });

  // Handle remaining unassigned nodes
  nodes.forEach((node) => {
    if (node.lane !== undefined) return;
    const y = (node as any).rowY;

    let parentLane: number | undefined;
    for (const parentId of node.parents) {
      const parent = nodesMap.get(parentId);
      if (parent && parent.lane !== undefined) {
        parentLane = parent.lane;
        if (!mainlineSet.has(parentId)) break;
      }
    }

    if (parentLane !== undefined && parentLane !== 0) {
      if (isLaneAvailable(parentLane, y)) {
        node.lane = parentLane;
        occupyLane(parentLane, y, y + Y_SPACING);
      } else {
        let lane = 1;
        while (!isLaneAvailable(lane, y)) lane++;
        node.lane = lane;
        occupyLane(lane, y, y + Y_SPACING);
      }
    } else {
      let lane = 1;
      while (!isLaneAvailable(lane, y)) lane++;
      node.lane = lane;
      occupyLane(lane, y, y + Y_SPACING);
    }
  });
}

export function applyLayout(mode: LayoutMode, nodes: CommitNode[]): CommitNode[] {
  const nodesCopy = nodes.map((n) => ({ ...n }));
  const nodesMap = new Map(nodesCopy.map((n) => [n.changeId, n]));

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

  return nodesCopy;
}
