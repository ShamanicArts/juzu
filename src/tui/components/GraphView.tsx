import { createEffect } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { CommitNode, FilesCacheEntry, LayoutMode } from "../../core/types";
import { getLaneColor } from "../../core/layout";

const BG = RGBA.fromHex("#24283b");
const SEL_BG = RGBA.fromInts(60, 70, 100, 180);
const FG_DIM = RGBA.fromHex("#888888");
const FG = RGBA.fromHex("#bbbbbb");
const GREEN = RGBA.fromHex("#00ff9d");
const RED = RGBA.fromHex("#ff0055");

const LANE_COLORS = [
  "#00f0ff", "#ff0055", "#00ff9d", "#ffaa00",
  "#aa00ff", "#00aaff", "#ffff00", "#ff00aa"
].map((h) => RGBA.fromHex(h));

interface GraphViewProps {
  nodes: CommitNode[];
  selectedId: string | null;
  scrollOffset: number;
  filesCache: Map<string, FilesCacheEntry>;
  width: number;
  height: number;
  onEnsureVisible: (visibleRows: number) => void;
  mergeSelectedIds?: Set<string>;
  mergeMode?: boolean;
  layoutMode?: LayoutMode;
}

export function GraphView(props: GraphViewProps) {
  const renderer = useRenderer();
  let canvas: FrameBufferRenderable | undefined;
  let parentBox: any = undefined;

  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const truncate = (s: string, maxLen: number) => {
    if (maxLen <= 0) return "";
    if (s.length <= maxLen) return s;
    return s.length > maxLen - 3 ? s.slice(0, maxLen - 3) + "..." : s;
  };

  const draw = () => {
    if (!canvas) return;

    const fb = canvas.frameBuffer;
    const w = props.width;
    const h = props.height;
    const headerH = 0;
    const graphH = h;

    if (w <= 0 || h <= 0) return;

    fb.fillRect(0, 0, w, h, BG);

    const rowStride = 4;
    const visibleRows = Math.max(1, Math.floor((graphH - 2) / rowStride));
    props.onEnsureVisible(visibleRows);

    const start = props.scrollOffset;
    const visible = props.nodes.slice(start, start + visibleRows);
    
    // Find selected index in visible range
    const selLocal = visible.findIndex(n => n.changeId === props.selectedId);

    let maxLane = 0;
    for (const n of props.nodes) maxLane = Math.max(maxLane, n.lane || 0);

    const minTextW = 28;
    const textGap = 3;
    const leftPad = 2;
    const maxLaneWidth = 4;
    const minLaneWidth = 2;
    const laneWidth = clamp(
      Math.floor((w - leftPad - textGap - minTextW) / Math.max(1, maxLane + 1)),
      minLaneWidth,
      maxLaneWidth
    );
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
      if (x < 0 || x >= w) return;
      if (absY < headerH || absY >= headerH + graphH) return;
      fb.setCell(x, absY, ch, fg, bgAtAbsY(absY));
    };

    if (selLocal >= 0 && selLocal < visible.length) {
      const y = rowYCell(selLocal);
      fb.fillRect(0, y, w, 1, SEL_BG);
      fb.fillRect(0, y + 1, w, 1, RGBA.fromInts(60, 70, 100, 90));
    }

    const selectedNode = selLocal >= 0 && selLocal < visible.length ? visible[selLocal] : null;

    // Mainline mode: draw a full-width "bus" ONLY at fork/merge points.
    // - Fork point: mainline commit that has an off-mainline child.
    // - Merge point: mainline commit that merges an off-mainline parent.
    const busYs = new Set<number>();
    if (props.layoutMode === "mainline" && maxLane > 0) {
      const childrenById = new Map<string, CommitNode[]>();
      for (const child of visible) {
        for (const pid of child.parents) {
          if (!indexById.has(pid)) continue;
          const arr = childrenById.get(pid) || [];
          arr.push(child);
          childrenById.set(pid, arr);
        }
      }

      for (let i = 0; i < visible.length; i++) {
        const node = visible[i];
        if ((node.lane || 0) !== 0) continue;
        const y = rowYCell(i);

        const kids = childrenById.get(node.changeId) || [];
        const isForkPoint = kids.some((k) => (k.lane || 0) !== 0);

        const isMergePoint =
          node.parents.length > 1 &&
          node.parents.some((pid) => {
            const pi = indexById.get(pid);
            if (pi === undefined) return false;
            return ((visible[pi]?.lane || 0) !== 0);
          });

        if (isForkPoint || isMergePoint) busYs.add(y);
      }

      // Draw the bus across the full lane span for each join row.
      const xTrunk = laneXCell(0);
      const xFurthest = laneXCell(maxLane);
      const trunkColor = LANE_COLORS[0];
      for (const y of busYs) {
        for (let x = Math.min(xTrunk, xFurthest); x <= Math.max(xTrunk, xFurthest); x++) {
          setGraphCell(x, y, "─", trunkColor);
        }
      }
    }
    
    // Draw connections (non-staggered: forks join at parent row, merges at child row)
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const lane = node.lane || 0;
      const x0 = laneXCell(lane);
      const y0 = rowYCell(i);
      const isSelectedNode = node === selectedNode;
      const color = LANE_COLORS[lane % LANE_COLORS.length];
      const baseColor = isSelectedNode
        ? RGBA.fromInts(Math.min(255, color.r + 80), Math.min(255, color.g + 80), Math.min(255, color.b + 80), 255)
        : color;

      for (let pIdx = 0; pIdx < node.parents.length; pIdx++) {
        const pid = node.parents[pIdx];
        const pi = indexById.get(pid);
        if (pi === undefined) continue;
        const parent = visible[pi];
        const pl = parent.lane || 0;
        const x1 = laneXCell(pl);
        const y1 = rowYCell(pi);
        const isParentSelected = parent === selectedNode;
        const isConnectionSelected = isSelectedNode || isParentSelected;
        const pc = LANE_COLORS[pl % LANE_COLORS.length];
        const parentColor = isParentSelected
          ? RGBA.fromInts(Math.min(255, pc.r + 80), Math.min(255, pc.g + 80), Math.min(255, pc.b + 80), 255)
          : pc;

        if (lane === pl) {
          const yMin = Math.min(y0, y1);
          const yMax = Math.max(y0, y1);
          const lineColor = isConnectionSelected ? parentColor : pc;
          for (let y = yMin + 1; y <= yMax - 1; y++) {
            setGraphCell(x0, y, isConnectionSelected ? "┃" : "|", lineColor);
          }
        } else {
          const isMergeCommit = node.parents.length > 1;
          const connectY = isMergeCommit ? y0 : y1;

          const useBus = props.layoutMode === "mainline" && busYs.has(connectY) && ((lane === 0) || (pl === 0));

          // Horizontal segment on the join row.
          // In mainline mode, the bus provides the full-width horizontal at join points.
          if (!useBus) {
            const xMin = Math.min(x0, x1);
            const xMax = Math.max(x0, x1);
            for (let x = xMin; x <= xMax; x++) {
              setGraphCell(x, connectY, isConnectionSelected ? "━" : "─", parentColor);
            }
          }

          if (isMergeCommit) {
            // Merge: horizontal at child row; vertical drops down to the parent lane.
            if (x0 < x1) {
              setGraphCell(x0, connectY, isConnectionSelected ? "┣" : "├", isSelectedNode ? baseColor : color);
              setGraphCell(x1, connectY, isConnectionSelected ? "┓" : "┐", parentColor);
            } else {
              setGraphCell(x0, connectY, isConnectionSelected ? "┫" : "┤", isSelectedNode ? baseColor : color);
              setGraphCell(x1, connectY, isConnectionSelected ? "┏" : "┌", parentColor);
            }

            for (let y = connectY + 1; y <= y1 - 1; y++) {
              setGraphCell(x1, y, isParentSelected ? "┃" : "│", parentColor);
            }
          } else {
            // Fork: horizontal at parent row; vertical rises up on the child's lane.
            if (x0 < x1) {
              setGraphCell(x1, connectY, isConnectionSelected ? "┣" : "├", parentColor);
              setGraphCell(x0, connectY, isConnectionSelected ? "┗" : "└", isSelectedNode ? baseColor : color);
            } else {
              setGraphCell(x1, connectY, isConnectionSelected ? "┫" : "┤", parentColor);
              setGraphCell(x0, connectY, isConnectionSelected ? "┛" : "┘", isSelectedNode ? baseColor : color);
            }

            for (let y = y0 + 1; y <= connectY - 1; y++) {
              setGraphCell(x0, y, isSelectedNode ? "┃" : "│", isSelectedNode ? baseColor : color);
            }
          }
        }
      }
    }

    // Draw nodes
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const lane = node.lane || 0;
      const x = laneXCell(lane);
      const y = rowYCell(i);
      const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
      const isSelected = i === selLocal;

      if (textX > x + 2) {
        for (let cx = x + 1; cx < Math.min(textX - 1, w); cx++) setGraphCell(cx, y, ".", laneColor);
      }

      let ch = isSelected ? "O" : "o";
      let fg = laneColor;
      if (props.mergeMode && props.mergeSelectedIds?.has(node.changeId)) {
        ch = "✓";
        fg = GREEN;
      } else if (node.isWorkingCopy) {
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

    // Draw text column
    for (let i = 0; i < visible.length; i++) {
      const node = visible[i];
      const y = rowYCell(i);
      const isSelected = i === selLocal;
      const lane = node.lane || 0;
      const laneColor = LANE_COLORS[lane % LANE_COLORS.length];
      const changeShort = node.changeId.slice(0, 8);
      const commitShort = node.commitId.slice(0, 8);
      const descMax = Math.max(0, w - textX - 2);
      const desc = truncate(node.descriptionTitle || "(no description)", descMax);

      if (textX < w - 1) {
        if (node.isWorkingCopy) fb.drawText("@", Math.max(0, textX - 2), y, GREEN);
        fb.drawText(changeShort, textX, y, isSelected ? RGBA.fromHex("#ffffff") : FG_DIM);
        fb.drawText(" ", textX + 8, y, FG_DIM);
        fb.drawText(commitShort, textX + 9, y, isSelected ? RGBA.fromHex("#ffffff") : FG_DIM);
        fb.drawText(desc, textX, y + 1, isSelected ? RGBA.fromHex("#ffffff") : FG);

        if (node.bookmarks.length > 0) {
          const bm = ` (${node.bookmarks.join(",")})`;
          fb.drawText(truncate(bm, Math.max(0, w - (textX + desc.length) - 1)), textX + Math.min(desc.length, descMax), y + 1, laneColor);
        }

        const filesCached = props.filesCache.get(node.changeId);
        if (filesCached && filesCached.files.length > 0) {
          const fileMaxW = Math.max(0, w - textX - 2);
          const fileTexts: string[] = [];
          for (const f of filesCached.files.slice(0, 3)) {
            fileTexts.push(`${f.type}:${f.path.split("/").pop() || f.path}`);
          }
          const fileLine = fileTexts.join(" ") + (filesCached.files.length > 3 ? ` +${filesCached.files.length - 3}` : "");
          fb.drawText(truncate(fileLine, fileMaxW), textX, y + 2, FG_DIM);
        } else if (filesCached) {
          fb.drawText("(no files)", textX, y + 2, FG_DIM);
        }
      }
    }

    canvas.requestRender?.();
  };

  const setupCanvas = (el: any) => {
    if (!el) return;
    parentBox = el;
    
    if (canvas) {
      try {
        parentBox.remove("graph-canvas");
      } catch {
        // ignore
      }
    }
    
    canvas = new FrameBufferRenderable(renderer, {
      id: "graph-canvas",
      width: props.width,
      height: props.height,
      respectAlpha: true,
      live: true,
    });
    
    parentBox.add(canvas);
    draw();
  };

  createEffect(() => {
    // Re-render when any of these change
    props.nodes;
    props.selectedId;
    props.scrollOffset;
    props.filesCache;
    props.width;
    props.height;
    
    if (canvas && parentBox) {
      (canvas as any).width = props.width;
      (canvas as any).height = props.height;
      draw();
    }
  });

  return <box ref={setupCanvas} width={props.width} height={props.height} backgroundColor={BG} />;
}
