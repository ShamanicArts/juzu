#!/usr/bin/env bun

import { createCliRenderer, FrameBufferRenderable, RGBA, type KeyEvent } from "@opentui/core";

export {};

interface CommitNode {
  changeId: string;
  commitId: string;
  parents: string[];
  author: string;
  time: string;
  bookmarks: string[];
  gitBranches: string[];
  descriptionTitle: string;
  descriptionFull: string;
  isEmpty: boolean;
  isConflict: boolean;
  isHidden: boolean;
  isRoot: boolean;
  isWorkingCopy: boolean;

  lane?: number;
}

type LayoutMode = "chronological" | "mainline" | "bookmark-centric" | "wc-focused" | "topological";

const BG = RGBA.fromHex("#24283b");
const PANEL_BG = RGBA.fromHex("#1a1b26");
const SEL_BG = RGBA.fromInts(60, 70, 100, 180);
const FG_DIM = RGBA.fromHex("#888888");
const FG = RGBA.fromHex("#bbbbbb");
const CYAN = RGBA.fromHex("#00f0ff");
const GREEN = RGBA.fromHex("#00ff9d");
const RED = RGBA.fromHex("#ff0055");

const LANE_COLORS_HEX = [
  "#00f0ff",
  "#ff0055",
  "#00ff9d",
  "#ffaa00",
  "#aa00ff",
  "#00aaff",
  "#ffff00",
  "#ff00aa",
];
const LANE_COLORS = LANE_COLORS_HEX.map((h) => RGBA.fromHex(h));

const JJ_TEMPLATE =
  `change_id.short() ++ "§" ++ commit_id.short() ++ "§" ++ parents.map(|p| p.change_id().short()).join(",") ++ "§" ++ author.email() ++ "§" ++ author.timestamp() ++ "§" ++ bookmarks.join(",") ++ "§" ++ description.first_line() ++ "§" ++ description ++ "§" ++ empty ++ "§" ++ conflict ++ "§" ++ hidden ++ "§" ++ root ++ "§<JJ-SEP>§"`;

async function findJJRoot(startDir: string): Promise<string | null> {
  let current = startDir;
  while (true) {
    try {
      await Bun.file(`${current}/.jj`).stat();
      return current;
    } catch {
      const parent = current.substring(0, current.lastIndexOf("/"));
      if (!parent || parent === current) return null;
      current = parent;
    }
  }
}

async function runCmdText(args: string[], cwd: string, timeoutMs = 15000): Promise<string> {
  const proc = Bun.spawn(args, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const timeout = setTimeout(() => {
    try {
      proc.kill();
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    if (exitCode !== 0) {
      const msg = (stderrText || "").trim() || `Command failed (${exitCode}): ${args.join(" ")}`;
      throw new Error(msg);
    }

    return stdoutText;
  } finally {
    clearTimeout(timeout);
  }
}

async function getWorkingCopyId(cwd: string): Promise<string> {
  return (await runCmdText(["jj", "log", "--no-graph", "-r", "@", "-T", "change_id.short()"], cwd, 8000)).trim();
}

async function fetchJJLog(cwd: string, limit: number): Promise<CommitNode[]> {
  const [logText, wcId] = await Promise.all([
    (async () => {
      return await runCmdText(["jj", "log", "--no-graph", "-r", "::", "--limit", String(limit), "-T", JJ_TEMPLATE], cwd, 15000);
    })(),
    getWorkingCopyId(cwd),
  ]);

  return logText
    .split("§<JJ-SEP>§")
    .map((b) => b.trim())
    .filter(Boolean)
    .map((block) => {
      const parts = block.split("§");
      if (parts.length < 12) return null;

      const changeId = parts[0].trim();
      const commitId = parts[1].trim();

      const root = parts[parts.length - 1].trim();
      const hidden = parts[parts.length - 2].trim();
      const conflict = parts[parts.length - 3].trim();
      const empty = parts[parts.length - 4].trim();

      const descriptionFull = parts.slice(7, parts.length - 4).join("§").trim();

      return {
        changeId,
        commitId,
        parents: parts[2] ? parts[2].split(",").map((p) => p.trim()).filter(Boolean) : [],
        author: parts[3].trim(),
        time: parts[4].trim(),
        bookmarks: parts[5] ? parts[5].split(",").map((b) => b.trim()).filter(Boolean) : [],
        gitBranches: [],
        descriptionTitle: parts[6].trim(),
        descriptionFull,
        isEmpty: empty === "true",
        isConflict: conflict === "true",
        isHidden: hidden === "true",
        isRoot: root === "true",
        isWorkingCopy: changeId === wcId,
      } satisfies CommitNode;
    })
    .filter(Boolean) as CommitNode[];
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

  // Branch commits off mainline get lanes 1..N (simple inherit + bump)
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

function applyLayout(mode: LayoutMode, nodes: CommitNode[]): CommitNode[] {
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

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function truncate(s: string, maxLen: number) {
  if (maxLen <= 0) return "";
  if (s.length <= maxLen) return s;
  return s.slice(0, Math.max(0, maxLen - 3)) + "...";
}

// Braille pixel canvas: 2x4 pixels per terminal cell.
class BrailleCanvas {
  private wCells: number;
  private hCells: number;
  private wPx: number;
  private hPx: number;
  private px: Uint32Array;

  constructor(wCells: number, hCells: number) {
    this.wCells = wCells;
    this.hCells = hCells;
    this.wPx = Math.max(0, wCells * 2);
    this.hPx = Math.max(0, hCells * 4);
    this.px = new Uint32Array(this.wPx * this.hPx);
  }

  clear() {
    this.px.fill(0);
  }

  private idx(x: number, y: number) {
    return y * this.wPx + x;
  }

  setPixel(x: number, y: number, color: RGBA) {
    if (x < 0 || y < 0 || x >= this.wPx || y >= this.hPx) return;
    // Store as 0xRRGGBB (alpha ignored for now)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const c: any = color;
    const v = ((c.r & 0xff) << 16) | ((c.g & 0xff) << 8) | (c.b & 0xff);
    this.px[this.idx(x, y)] = v;
  }

  drawLine(x0: number, y0: number, x1: number, y1: number, color: RGBA, thickness = 1) {
    // Bresenham with simple thickness
    let dx = Math.abs(x1 - x0);
    let sx = x0 < x1 ? 1 : -1;
    let dy = -Math.abs(y1 - y0);
    let sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;

    while (true) {
      for (let ox = -thickness; ox <= thickness; ox++) {
        for (let oy = -thickness; oy <= thickness; oy++) {
          if (ox * ox + oy * oy <= thickness * thickness) this.setPixel(x0 + ox, y0 + oy, color);
        }
      }
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  drawCircle(cx: number, cy: number, r: number, color: RGBA, fill = true) {
    if (r <= 0) {
      this.setPixel(cx, cy, color);
      return;
    }

    let x = r;
    let y = 0;
    let err = 1 - x;

    const plot = (px: number, py: number) => this.setPixel(px, py, color);
    const hline = (x0: number, x1: number, y0: number) => {
      const a = Math.min(x0, x1);
      const b = Math.max(x0, x1);
      for (let xx = a; xx <= b; xx++) plot(xx, y0);
    };

    while (x >= y) {
      if (fill) {
        hline(cx - x, cx + x, cy + y);
        hline(cx - x, cx + x, cy - y);
        hline(cx - y, cx + y, cy + x);
        hline(cx - y, cx + y, cy - x);
      } else {
        plot(cx + x, cy + y);
        plot(cx - x, cy + y);
        plot(cx + x, cy - y);
        plot(cx - x, cy - y);
        plot(cx + y, cy + x);
        plot(cx - y, cy + x);
        plot(cx + y, cy - x);
        plot(cx - y, cy - x);
      }

      y++;
      if (err < 0) {
        err += 2 * y + 1;
      } else {
        x--;
        err += 2 * (y - x) + 1;
      }
    }
  }

  blitToFrameBuffer(fb: any, dstX: number, dstY: number, bg: RGBA, bgOverride?: (cellX: number, cellY: number) => RGBA) {
    for (let cy = 0; cy < this.hCells; cy++) {
      for (let cx = 0; cx < this.wCells; cx++) {
        let mask = 0;
        const colors: number[] = [];
        const counts: number[] = [];

        for (let py = 0; py < 4; py++) {
          for (let px = 0; px < 2; px++) {
            const x = cx * 2 + px;
            const y = cy * 4 + py;
            const v = this.px[this.idx(x, y)];
            if (v === 0) continue;

            if (px === 0 && py === 0) mask |= 0x01;
            else if (px === 0 && py === 1) mask |= 0x02;
            else if (px === 0 && py === 2) mask |= 0x04;
            else if (px === 0 && py === 3) mask |= 0x40;
            else if (px === 1 && py === 0) mask |= 0x08;
            else if (px === 1 && py === 1) mask |= 0x10;
            else if (px === 1 && py === 2) mask |= 0x20;
            else if (px === 1 && py === 3) mask |= 0x80;

            const idx = colors.indexOf(v);
            if (idx === -1) {
              colors.push(v);
              counts.push(1);
            } else {
              counts[idx]++;
            }
          }
        }

        const bgCell = bgOverride ? bgOverride(cx, cy) : bg;

        if (mask === 0) {
          fb.setCell(dstX + cx, dstY + cy, " ", RGBA.fromHex("#000000"), bgCell);
          continue;
        }

        // Choose most frequent color in the cell
        let best = 0;
        let bestCount = -1;
        for (let i = 0; i < colors.length; i++) {
          if (counts[i] > bestCount) {
            bestCount = counts[i];
            best = colors[i];
          }
        }

        const r = (best >> 16) & 0xff;
        const g = (best >> 8) & 0xff;
        const b = best & 0xff;
        const fg = RGBA.fromInts(r, g, b, 255);
        const ch = String.fromCodePoint(0x2800 + mask);
        fb.setCell(dstX + cx, dstY + cy, ch, fg, bgCell);
      }
    }
  }
}

async function main() {
  const startDir = process.cwd();
  const cwd = await findJJRoot(startDir);
  if (!cwd) {
    console.error(`No .jj directory found in "${startDir}" or any parent directory.`);
    process.exit(1);
  }

  const renderer = await createCliRenderer({ exitOnCtrlC: false });

  let mode: LayoutMode = "chronological";
  let nodes: CommitNode[] = [];
  let laidOut: CommitNode[] = [];
  let selectedIndex = 0;
  let scrollOffset = 0;
  let statusMsg = "";
  let isRefreshing = false;

  let descExpanded = false;
  let filesExpanded = false;
  let rebaseSource: string | null = null;

  const filesCache = new Map<string, { atMs: number; files: Array<{ type: string; path: string }> }>();
  const FILES_TTL_MS = 5000;

  const prompt = {
    active: false,
    label: "",
    value: "",
    onSubmit: null as null | ((value: string) => Promise<void>),
  };

  let termW = process.stdout.columns ?? 80;
  let termH = process.stdout.rows ?? 24;

  let canvas: FrameBufferRenderable | null = null;

  const startPrompt = (label: string, initial: string, onSubmit: (value: string) => Promise<void>) => {
    prompt.active = true;
    prompt.label = label;
    prompt.value = initial;
    prompt.onSubmit = onSubmit;
  };

  const cancelPrompt = () => {
    prompt.active = false;
    prompt.label = "";
    prompt.value = "";
    prompt.onSubmit = null;
  };

  const recreateCanvas = (w: number, h: number) => {
    termW = w;
    termH = h;

    if (canvas) {
      try {
        // Root is a renderable container that supports remove(id).
        (renderer.root as any).remove("jjviz");
      } catch {
        // Best-effort; older versions may not support remove on root.
      }
    }

    canvas = new FrameBufferRenderable(renderer, {
      id: "jjviz",
      width: w,
      height: h,
      respectAlpha: true,
      // Keep a continuous render loop so buffer updates are visible.
      live: true,
    });
    renderer.root.add(canvas);
  };

  const refresh = async () => {
    if (isRefreshing) return;
    isRefreshing = true;
    statusMsg = "Loading...";
    render();
    try {
      nodes = await fetchJJLog(cwd, 500);
      if (nodes.length === 0) {
        statusMsg = "No commits returned by jj log";
      }
      laidOut = applyLayout(mode, nodes);
      const wcIndex = laidOut.findIndex((n) => n.isWorkingCopy);
      selectedIndex = wcIndex >= 0 ? wcIndex : 0;
      scrollOffset = clamp(selectedIndex - 10, 0, Math.max(0, laidOut.length - 1));
      if (nodes.length > 0) statusMsg = "";
    } catch (e) {
      statusMsg = `Error: ${String(e)}`;
      nodes = [];
      laidOut = [];
      selectedIndex = 0;
      scrollOffset = 0;
    }
    isRefreshing = false;
    render();
  };

  const setMode = (m: LayoutMode) => {
    mode = m;
    laidOut = applyLayout(mode, nodes);
    selectedIndex = clamp(selectedIndex, 0, Math.max(0, laidOut.length - 1));
    scrollOffset = clamp(scrollOffset, 0, Math.max(0, laidOut.length - 1));
    render();
  };

  const ensureSelectedVisible = (visibleRows: number) => {
    if (selectedIndex < scrollOffset) scrollOffset = selectedIndex;
    const maxTop = Math.max(0, laidOut.length - visibleRows);
    const bottom = scrollOffset + (visibleRows - 1);
    if (selectedIndex > bottom) scrollOffset = clamp(selectedIndex - (visibleRows - 1), 0, maxTop);
    scrollOffset = clamp(scrollOffset, 0, maxTop);
  };

  const render = () => {
    if (!canvas) return;

    const fb = canvas.frameBuffer;
    const w = termW;
    const h = termH;
    if (w <= 0 || h <= 0) return;

    const showSidebar = w >= 90 && h >= 16;
    const baseFooterH = showSidebar ? 0 : 4;
    const promptH = prompt.active ? 1 : 0;
    const footerH = baseFooterH + promptH;
    const headerH = 2;

    // Background
    fb.fillRect(0, 0, w, h, BG);

    const detailW = showSidebar ? clamp(Math.floor(w * 0.33), 28, Math.max(28, w - 40)) : 0;
    const graphW = w - detailW;
    const graphH = h - headerH - footerH;

    // Header
    fb.fillRect(0, 0, w, headerH, PANEL_BG);
    fb.drawText("jj-viz", 2, 0, CYAN);
    fb.drawText("TUI", 9, 0, FG_DIM);
    fb.drawText(truncate(`nodes:${laidOut.length}`, w - 20), w - Math.min(18, w - 1), 0, FG_DIM);
    if (statusMsg) fb.drawText(truncate(statusMsg, w - 14), 14, 0, RED);
    const hint = rebaseSource
      ? `layout:${mode}  rebase src:${rebaseSource.slice(0, 8)} (select dest + b, esc cancels)`
      : `layout:${mode}  j/k nav  x desc  f files  d describe  b rebase  r refresh  q quit`;
    fb.drawText(truncate(hint, w - 4), 2, 1, FG_DIM);

    if (graphH <= 0) return;

    if (showSidebar) {
      // Divider
      for (let y = headerH; y < headerH + graphH; y++) fb.setCell(graphW, y, "|", RGBA.fromHex("#444444"), BG);

      // Details panel background
      fb.fillRect(graphW + 1, headerH, detailW - 1, graphH, PANEL_BG);
    }

    // Graph pane background
    fb.fillRect(0, headerH, graphW, graphH, BG);

    // Compute layout in terminal-space
    const rowStride = 3; // 2 lines per commit + 1 spacer
    const visibleRows = Math.max(1, Math.floor((graphH - 2) / rowStride));
    ensureSelectedVisible(visibleRows);

    const start = scrollOffset;
    const end = Math.min(laidOut.length, start + visibleRows);
    const visible = laidOut.slice(start, end);

    let maxLane = 0;
    for (const n of laidOut) maxLane = Math.max(maxLane, n.lane || 0);

    const minTextW = 28;
    const textGap = 3;
    const leftPad = 2;
    const maxLaneWidth = 4;
    const minLaneWidth = 2;
    const laneWidth = clamp(Math.floor((graphW - leftPad - textGap - minTextW) / Math.max(1, maxLane + 1)), minLaneWidth, maxLaneWidth);
    const lanesW = (maxLane + 1) * laneWidth;
    const textX = leftPad + lanesW + textGap;

    const indexById = new Map<string, number>();
    visible.forEach((n, i) => indexById.set(n.changeId, i));

    const rowYCell = (i: number) => headerH + 1 + i * rowStride;
    const laneXCell = (lane: number) => leftPad + (maxLane - lane) * laneWidth;

    const bgAtAbsY = (absY: number) => {
      if (selLocal >= 0 && selLocal < visible.length) {
        const rowTop = rowYCell(selLocal);
        if (absY === rowTop) return SEL_BG;
        if (absY === rowTop + 1) return RGBA.fromInts(60, 70, 100, 90);
      }
      return BG;
    };

    const setGraphCell = (x: number, absY: number, ch: string, fg: RGBA) => {
      if (x < 0 || x >= graphW) return;
      if (absY < headerH || absY >= headerH + graphH) return;
      fb.setCell(x, absY, ch, fg, bgAtAbsY(absY));
    };

    // Selected row background
    const selLocal = selectedIndex - scrollOffset;
    if (selLocal >= 0 && selLocal < visible.length) {
      const y = rowYCell(selLocal);
      fb.fillRect(0, y, graphW, 1, SEL_BG);
      fb.fillRect(0, y + 1, graphW, 1, RGBA.fromInts(60, 70, 100, 90));
    }

    // Connections (cell-drawn)
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const lane = node.lane || 0;
      const x0 = laneXCell(lane);
      const y0 = rowYCell(i);
      const color = LANE_COLORS[lane % LANE_COLORS.length];

      for (let pIdx = 0; pIdx < node.parents.length; pIdx++) {
        const pid = node.parents[pIdx];
        const pi = indexById.get(pid);
        if (pi === undefined) continue;
        const parent = visible[pi];
        const pl = parent.lane || 0;
        const x1 = laneXCell(pl);
        const y1 = rowYCell(pi);
        const pc = LANE_COLORS[pl % LANE_COLORS.length];

        if (lane === pl) {
          const yMin = Math.min(y0, y1);
          const yMax = Math.max(y0, y1);
          for (let y = yMin + 1; y <= yMax - 1; y++) setGraphCell(x0, y, "|", pc);
        } else {
          const yMin = Math.min(y0, y1);
          const yMax = Math.max(y0, y1);
          const midY = yMin + Math.floor((yMax - yMin) / 2);

          // Vertical from node to mid
          const yStart = Math.min(y0, midY);
          const yEnd = Math.max(y0, midY);
          for (let y = yStart + 1; y <= yEnd; y++) setGraphCell(x0, y, "|", color);

          // Horizontal at mid
          const xMin = Math.min(x0, x1);
          const xMax = Math.max(x0, x1);
          for (let x = xMin; x <= xMax; x++) setGraphCell(x, midY, "-", pc);
          setGraphCell(x0, midY, "+", color);
          setGraphCell(x1, midY, "+", pc);

          // Vertical from mid to parent
          const yStart2 = Math.min(midY, y1);
          const yEnd2 = Math.max(midY, y1);
          for (let y = yStart2; y <= yEnd2 - 1; y++) setGraphCell(x1, y, "|", pc);
        }
      }
    }

    // Nodes + dotted connectors to text column
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const lane = node.lane || 0;
      const x = laneXCell(lane);
      const y = rowYCell(i);
      const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
      const isSelected = i === selLocal;

      // Connector to text column
      if (textX > x + 2) {
        for (let cx = x + 1; cx < Math.min(textX - 1, graphW); cx++) setGraphCell(cx, y, ".", laneColor);
      }

      // Node marker
      let ch = isSelected ? "O" : "o";
      let fg = laneColor;
      if (node.isWorkingCopy) {
        ch = "@";
        fg = GREEN;
      } else if (node.isConflict) {
        ch = "!";
        fg = RED;
      } else if (node.isEmpty) {
        ch = isSelected ? "0" : "o";
        fg = FG_DIM;
      }
      setGraphCell(x, y, ch, fg);
    }

    // Text column (cell-drawn)
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const y = rowYCell(i);
      const isSelected = i === selLocal;
      const lane = node.lane || 0;
      const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
      const changeShort = node.changeId.slice(0, 8);
      const commitShort = node.commitId.slice(0, 8);
      const descMax = Math.max(0, graphW - textX - 2);
      const desc = truncate(node.descriptionTitle || "(no description)", descMax);

      if (textX < graphW - 1) {
        if (node.isWorkingCopy) fb.drawText("@", Math.max(0, textX - 2), y, GREEN);
        // Line 1: change + commit
        fb.drawText(changeShort, textX, y, isSelected ? RGBA.fromHex("#ffffff") : FG_DIM);
        fb.drawText(" ", textX + 8, y, FG_DIM);
        fb.drawText(commitShort, textX + 9, y, isSelected ? RGBA.fromHex("#ffffff") : FG_DIM);

        // Line 2: description under IDs
        fb.drawText(desc, textX, y + 1, isSelected ? RGBA.fromHex("#ffffff") : FG);

        if (node.bookmarks.length > 0) {
          const bm = ` (${node.bookmarks.join(",")})`;
          fb.drawText(truncate(bm, Math.max(0, graphW - (textX + desc.length) - 1)), textX + Math.min(desc.length, descMax), y + 1, laneColor);
        }
      }
    }

    if (showSidebar) {
      // Details panel
      const selected = laidOut[selectedIndex];
      const dx = graphW + 2;
      let dy = headerH + 1;

      fb.drawText("Details", dx, dy++, CYAN);
      fb.drawText("--------", dx, dy++, RGBA.fromHex("#444444"));

      if (!selected) {
        fb.drawText("No commit selected", dx, dy++, FG_DIM);
      } else {
        fb.drawText(`Change: ${selected.changeId}${selected.isWorkingCopy ? " (@)" : ""}`, dx, dy++, selected.isWorkingCopy ? GREEN : CYAN);
        fb.drawText(`Commit: ${selected.commitId}`, dx, dy++, FG_DIM);
        fb.drawText(`Author: ${selected.author}`, dx, dy++, FG_DIM);
        fb.drawText(`Time: ${selected.time}`, dx, dy++, FG_DIM);
        dy++;
        if (selected.bookmarks.length > 0) {
          fb.drawText("Bookmarks:", dx, dy++, FG_DIM);
          for (const b of selected.bookmarks.slice(0, 6)) fb.drawText(`- ${b}`, dx, dy++, CYAN);
          dy++;
        }
        // Description directly under Change/Commit
        fb.drawText(descExpanded ? "Description (x to collapse):" : "Description (x to expand):", dx, dy++, FG_DIM);
        const dlines = (selected.descriptionFull || selected.descriptionTitle || "(no description)").split("\n");
        const descLinesToShow = descExpanded ? Math.max(2, (headerH + graphH) - dy - 10) : 2;
        for (const line of dlines.slice(0, descLinesToShow)) {
          fb.drawText(truncate(line || "", detailW - 4), dx, dy++, FG);
        }
        if (!descExpanded && dlines.length > 2) {
          fb.drawText(truncate("...", detailW - 4), dx, dy++, FG_DIM);
        }
        dy++;

        // Files section
        fb.drawText(filesExpanded ? "Files (f to collapse):" : "Files (f to expand):", dx, dy++, FG_DIM);
        if (filesExpanded) {
          const cached = filesCache.get(selected.changeId);
          const fresh = cached && Date.now() - cached.atMs < FILES_TTL_MS;
          if (!fresh) {
            fb.drawText("(loading...)", dx, dy++, FG_DIM);
          } else {
            const maxLines = Math.max(1, (headerH + graphH) - dy - 1);
            for (const f of cached!.files.slice(0, maxLines)) {
              fb.drawText(truncate(`${f.type} ${f.path}`, detailW - 4), dx, dy++, FG);
            }
            if (cached!.files.length > maxLines) fb.drawText(truncate("...", detailW - 4), dx, dy++, FG_DIM);
          }
        }

        if (selected.isConflict) fb.drawText("! conflicts", dx, dy++, RED);
      }
    } else {
      // Footer detail strip
      fb.fillRect(0, headerH + graphH, w, footerH, PANEL_BG);
      const selected = laidOut[selectedIndex];
      const y0 = headerH + graphH;
      if (!selected) {
        fb.drawText("No commit selected", 2, y0 + 1, FG_DIM);
      } else {
        fb.drawText(`Change: ${selected.changeId}${selected.isWorkingCopy ? " (@)" : ""}`, 2, y0 + 1, selected.isWorkingCopy ? GREEN : CYAN);
        fb.drawText(`Commit: ${selected.commitId}`, 2, y0 + 2, FG_DIM);
        fb.drawText(truncate(selected.descriptionTitle || "(no description)", w - 4), 2, y0 + 3, FG);
      }
    }

    // Prompt line (uses reserved footer row)
    if (prompt.active) {
      const py = headerH + graphH + baseFooterH;
      fb.fillRect(0, py, w, 1, PANEL_BG);
      const cursor = "_";
      const text = `:${prompt.label}${prompt.value}${cursor}`;
      fb.drawText(truncate(text, w - 2), 1, py, CYAN);
    }

    // Ensure the renderer flushes the updated framebuffer.
    try {
      (canvas as any).requestRender?.();
    } catch {
      // ignore
    }
  };

  renderer.on("resize", (w: number, h: number) => {
    recreateCanvas(w, h);
    render();
  });

  const fetchFilesForSelected = async () => {
    const selected = laidOut[selectedIndex];
    if (!selected) return;
    const cached = filesCache.get(selected.changeId);
    if (cached && Date.now() - cached.atMs < FILES_TTL_MS) return;

    try {
      const out = await runCmdText(["jj", "diff", "--summary", "-r", selected.changeId], cwd, 8000);
      const files = out
        .trim()
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const [type, ...rest] = line.split(" ");
          return { type, path: rest.join(" ") };
        });
      filesCache.set(selected.changeId, { atMs: Date.now(), files });
    } catch (e) {
      statusMsg = `files error: ${String(e)}`;
    }
  };

  const runAndRefresh = async (args: string[]) => {
    try {
      statusMsg = `running: ${args.join(" ")}`;
      render();
      await runCmdText(args, cwd, 20000);
      statusMsg = "";
    } catch (e) {
      statusMsg = `error: ${String(e)}`;
    }
    await refresh();
  };

  const onKey = async (key: KeyEvent) => {
    const name = ((key.name || key.sequence || "") as string).toLowerCase();

    // Inline prompt input (no overlays)
    if (prompt.active) {
      if (name === "escape") {
        cancelPrompt();
        render();
        return;
      }

      if (name === "return" || name === "enter") {
        const cb = prompt.onSubmit;
        const value = prompt.value;
        cancelPrompt();
        render();
        if (cb) await cb(value);
        return;
      }

      if (name === "backspace") {
        prompt.value = prompt.value.slice(0, Math.max(0, prompt.value.length - 1));
        render();
        return;
      }

      const seq = (key.sequence || "") as string;
      if (!key.ctrl && !key.meta && seq.length === 1) {
        const code = seq.charCodeAt(0);
        if (code >= 32 && code <= 126) {
          prompt.value = (prompt.value + seq).slice(0, 200);
          render();
          return;
        }
      }

      // Ignore other keys while prompting
      render();
      return;
    }

    if (key.ctrl && key.name === "c") {
      renderer.destroy();
      return;
    }

    switch (name) {
      case "q":
        renderer.destroy();
        return;
      case "escape":
        rebaseSource = null;
        render();
        return;
      case "up":
      case "k":
        selectedIndex = clamp(selectedIndex - 1, 0, Math.max(0, laidOut.length - 1));
        if (filesExpanded) void fetchFilesForSelected();
        render();
        return;
      case "down":
      case "j":
        selectedIndex = clamp(selectedIndex + 1, 0, Math.max(0, laidOut.length - 1));
        if (filesExpanded) void fetchFilesForSelected();
        render();
        return;
      case "r":
        await refresh();
        return;
      case "f":
        filesExpanded = !filesExpanded;
        if (filesExpanded) void fetchFilesForSelected();
        render();
        return;
      case "x":
        descExpanded = !descExpanded;
        render();
        return;
      case "d": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        startPrompt("describe> ", selected.descriptionTitle || "", async (value) => {
          await runAndRefresh(["jj", "describe", "-r", selected.changeId, "-m", value]);
        });
        render();
        return;
      }
      case "e": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        await runAndRefresh(["jj", "edit", selected.changeId]);
        return;
      }
      case "n": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        await runAndRefresh(["jj", "new", selected.changeId]);
        return;
      }
      case "a": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        await runAndRefresh(["jj", "abandon", selected.changeId]);
        return;
      }
      case "s": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        await runAndRefresh(["jj", "squash", "--from", selected.changeId]);
        return;
      }
      case "b": {
        const selected = laidOut[selectedIndex];
        if (!selected) return;
        if (!rebaseSource) {
          rebaseSource = selected.changeId;
          statusMsg = `rebase source set: ${rebaseSource.slice(0, 8)}`;
          render();
          return;
        }
        if (rebaseSource === selected.changeId) {
          statusMsg = "pick a different destination";
          render();
          return;
        }
        const src = rebaseSource;
        rebaseSource = null;
        await runAndRefresh(["jj", "rebase", "-s", src, "-d", selected.changeId]);
        return;
      }
      case "1":
        setMode("chronological");
        return;
      case "2":
        setMode("mainline");
        return;
      case "3":
        setMode("bookmark-centric");
        return;
      case "4":
        setMode("wc-focused");
        return;
      case "5":
        setMode("topological");
        return;
    }

    render();
  };

  (renderer.keyInput as any).on("keypress", (k: KeyEvent) => {
    void onKey(k).catch((e: unknown) => {
      statusMsg = `Key handler error: ${String(e)}`;
      render();
    });
  });

  // Initial canvas sized to terminal.
  recreateCanvas(termW, termH);

  await refresh();
}

await main();
