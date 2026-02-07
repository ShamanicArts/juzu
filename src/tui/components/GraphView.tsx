import { createEffect } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { FrameBufferRenderable, RGBA, convertGlobalToLocalSelection } from "@opentui/core";
import type { CommitNode, FilesCacheEntry, LayoutMode } from "../../core/types";
import { UI_TOKENS } from "../../core/ui-tokens";

const BG = () => RGBA.fromHex(UI_TOKENS.slate.bg0);
const FG = () => RGBA.fromHex(UI_TOKENS.slate.text);
const GREEN = () => RGBA.fromHex(UI_TOKENS.semantic.success);
const RED = () => RGBA.fromHex(UI_TOKENS.semantic.error);
const YELLOW = () => RGBA.fromHex(UI_TOKENS.semantic.warn);
const CYAN = () => RGBA.fromHex(UI_TOKENS.semantic.info);

// Graph text colors with theme fallbacks - hex strings
const graphColorsHex = {
  commitId: () => (UI_TOKENS as any).graph?.commitId ?? UI_TOKENS.slate.textMuted,
  bookmark: () => (UI_TOKENS as any).graph?.bookmark ?? UI_TOKENS.semantic.warn,
  bookmarkSelected: () => (UI_TOKENS as any).graph?.bookmarkSelected ?? "#e8c884",
  fileAdd: () => (UI_TOKENS as any).graph?.fileAdd ?? UI_TOKENS.semantic.success,
  fileMod: () => (UI_TOKENS as any).graph?.fileMod ?? UI_TOKENS.semantic.warn,
  fileDel: () => (UI_TOKENS as any).graph?.fileDel ?? UI_TOKENS.semantic.error,
  textMuted: () => (UI_TOKENS as any).graph?.textMuted ?? UI_TOKENS.slate.textMuted,
  fg: () => UI_TOKENS.slate.text,
};

// Helper to brighten a hex color for selected items
const brighten = (hexColor: string, add: number = 60) => {
  const r = parseInt(hexColor.slice(1, 3), 16);
  const g = parseInt(hexColor.slice(3, 5), 16);
  const b = parseInt(hexColor.slice(5, 7), 16);
  const newR = Math.min(255, r + add).toString(16).padStart(2, "0");
  const newG = Math.min(255, g + add).toString(16).padStart(2, "0");
  const newB = Math.min(255, b + add).toString(16).padStart(2, "0");
  return RGBA.fromHex(`#${newR}${newG}${newB}`);
};

// Toggle: false = highlight lines (white), true = highlight node circle (white)
const HIGHLIGHT_NODE_CIRCLE = true;

const laneColors = () => UI_TOKENS.graph.lanes.map((h) => RGBA.fromHex(h));

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
  themeVersion?: number;
}

type LocalSelection = {
  anchorX: number;
  anchorY: number;
  focusX: number;
  focusY: number;
  isActive: boolean;
};

class SelectableFrameBufferRenderable extends FrameBufferRenderable {
  private localSelection: LocalSelection | null = null;
  private readonly getLines: () => string[];

  constructor(ctx: any, options: ConstructorParameters<typeof FrameBufferRenderable>[1] & { getLines: () => string[] }) {
    super(ctx, options);
    this.selectable = true;
    this.getLines = options.getLines;
  }

  shouldStartSelection(x: number, y: number): boolean {
    const localX = x - this.x;
    const localY = y - this.y;
    return localX >= 0 && localY >= 0 && localX < this.width && localY < this.height;
  }

  onSelectionChanged(selection: any): boolean {
    this.localSelection = convertGlobalToLocalSelection(selection, this.x, this.y) as LocalSelection | null;
    return this.hasSelection();
  }

  hasSelection(): boolean {
    if (!this.localSelection?.isActive) return false;
    return this.localSelection.anchorX !== this.localSelection.focusX || this.localSelection.anchorY !== this.localSelection.focusY;
  }

  getSelectedText(): string {
    if (!this.localSelection?.isActive) return "";

    const lines = this.getLines();
    if (lines.length === 0) return "";

    let ax = this.localSelection.anchorX;
    let ay = this.localSelection.anchorY;
    let fx = this.localSelection.focusX;
    let fy = this.localSelection.focusY;

    const forward = ay < fy || (ay === fy && ax <= fx);
    if (!forward) {
      [ax, fx] = [fx, ax];
      [ay, fy] = [fy, ay];
    }

    ay = Math.max(0, Math.min(ay, lines.length - 1));
    fy = Math.max(0, Math.min(fy, lines.length - 1));

    const clampX = (x: number) => Math.max(0, Math.min(x, this.width - 1));
    ax = clampX(ax);
    fx = clampX(fx);

    const endExclusive = fx + 1;
    const out: string[] = [];

    const sliceWithPadding = (line: string, start: number, end: number) => {
      const padded = line.padEnd(Math.max(end, 0), " ");
      return padded.slice(Math.max(0, start), Math.max(0, end));
    };

    for (let y = ay; y <= fy; y++) {
      const line = lines[y] || "";
      if (y === ay && y === fy) {
        out.push(sliceWithPadding(line, ax, endExclusive).replace(/[ \t]+$/, ""));
      } else if (y === ay) {
        out.push(sliceWithPadding(line, ax, this.width).replace(/[ \t]+$/, ""));
      } else if (y === fy) {
        out.push(sliceWithPadding(line, 0, endExclusive).replace(/[ \t]+$/, ""));
      } else {
        out.push(line.replace(/[ \t]+$/, ""));
      }
    }

    return out.join("\n").replace(/[\n\r]+$/, "");
  }
}

export function GraphView(props: GraphViewProps) {
  const renderer = useRenderer();
  let canvas: SelectableFrameBufferRenderable | undefined;
  let parentBox: any = undefined;
  let graphLines: string[] = [];
  // Reusable maps to avoid allocating new Maps on every draw frame
  let _indexByIdAll: Map<string, number> | null = null;
  let _childrenById: Map<string, CommitNode[]> | null = null;

  const viewBg = () => {
    props.themeVersion;
    return BG();
  };

  const tryCreateCanvas = () => {
    if (!parentBox || canvas) return;
    if (props.width <= 0 || props.height <= 0) return;

    canvas = new SelectableFrameBufferRenderable(renderer, {
      id: "graph-canvas",
      width: props.width,
      height: props.height,
      respectAlpha: true,
      live: false,
      getLines: () => graphLines,
    });

    canvas.frameBuffer.fillRect(0, 0, props.width, props.height, BG());
    draw();
    parentBox.add(canvas);
  };

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

    fb.fillRect(0, 0, w, h, BG());

    const rowStride = 4;
    const visibleRows = Math.max(1, Math.floor((graphH - 2) / rowStride));
    props.onEnsureVisible(visibleRows);

    const start = props.scrollOffset;
    const visible = props.nodes.slice(start, start + visibleRows);
    const end = start + visible.length;
    
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

    // Global index so we can render connections that span beyond the visible window.
    // This fixes missing lane/edge segments when one endpoint is off-screen.
    // Reuse the map across frames to reduce allocation pressure.
    if (!_indexByIdAll) _indexByIdAll = new Map<string, number>();
    else _indexByIdAll.clear();
    const indexByIdAll = _indexByIdAll;
    for (let i = 0; i < props.nodes.length; i++) indexByIdAll.set(props.nodes[i].changeId, i);

    const rowYCell = (i: number) => headerH + 1 + i * rowStride;
    const rowYAbs = (globalIndex: number) => headerH + 1 + (globalIndex - start) * rowStride;
    const laneXCell = (lane: number) => leftPad + (maxLane - lane) * laneWidth;

    const bgAtAbsY = (_absY: number) => BG();

    const LANE_COLORS = laneColors();

    const setGraphCell = (x: number, absY: number, ch: string, fg: RGBA) => {
      if (x < 0 || x >= w) return;
      if (absY < headerH || absY >= headerH + graphH) return;
      fb.setCell(x, absY, ch, fg, bgAtAbsY(absY));
    };

    const selectedNode = selLocal >= 0 && selLocal < visible.length ? visible[selLocal] : null;
    const selectedId = props.selectedId;
    const WHITE = RGBA.fromHex("#ffffff");

    // Mainline mode: draw a horizontal "bus" only as far as needed.
    // We still want an easy-to-read trunk, but we should not paint a full-width
    // bar across all lanes when only a single branch connects.
    //
    // busByY maps a join-row Y -> [minX, maxX] span to draw.
    const busByY = new Map<number, { minX: number; maxX: number }>();
    if (props.layoutMode === "mainline" && maxLane > 0) {
      // Build child lists from the full graph so fork/merge points can render
      // even when the connected commit is off-screen.
      // Reuse arrays where possible; clear between frames.
      if (!_childrenById) _childrenById = new Map<string, CommitNode[]>();
      else {
        for (const arr of _childrenById.values()) arr.length = 0;
        _childrenById.clear();
      }
      const childrenById = _childrenById;
      for (const child of props.nodes) {
        for (const pid of child.parents) {
          const arr = childrenById.get(pid);
          if (arr) arr.push(child);
          else childrenById.set(pid, [child]);
        }
      }

      for (let i = 0; i < visible.length; i++) {
        const node = visible[i];
        if ((node.lane || 0) !== 0) continue;
        const y = rowYCell(i);

        const connectedLanes: number[] = [];

        // Fork point: mainline node with off-mainline child(ren)
        const kids = childrenById.get(node.changeId) || [];
        for (const k of kids) {
          const kl = k.lane || 0;
          if (kl !== 0) connectedLanes.push(kl);
        }

        // Merge point: mainline node with an off-mainline parent
        if (node.parents.length > 1) {
          for (const pid of node.parents) {
            const pi = indexByIdAll.get(pid);
            if (pi === undefined) continue;
            const pl = props.nodes[pi]?.lane || 0;
            if (pl !== 0) connectedLanes.push(pl);
          }
        }

        if (connectedLanes.length === 0) continue;

        const furthestLane = Math.max(...connectedLanes);
        const xTrunk = laneXCell(0);
        const xFurthest = laneXCell(furthestLane);
        busByY.set(y, { minX: Math.min(xTrunk, xFurthest), maxX: Math.max(xTrunk, xFurthest) });
      }

      // Draw each bus segment with trunk color.
      const trunkColor = LANE_COLORS[0];
      for (const [y, span] of busByY.entries()) {
        for (let x = span.minX; x <= span.maxX; x++) {
          setGraphCell(x, y, "─", trunkColor);
        }
      }
    }
    
    // Draw connections (non-staggered: forks join at parent row, merges at child row).
    // Important: render edge segments that intersect the visible window even if
    // either endpoint commit is off-screen, so long vertical lanes stay visible.
    const viewTop = headerH;
    const viewBottom = headerH + graphH - 1;

    const drawVert = (x: number, yA: number, yB: number, ch: string, fg: RGBA) => {
      const yMin = Math.min(yA, yB);
      const yMax = Math.max(yA, yB);
      const from = Math.max(yMin, viewTop);
      const to = Math.min(yMax, viewBottom);
      for (let y = from; y <= to; y++) setGraphCell(x, y, ch, fg);
    };

    const drawHorz = (xA: number, xB: number, y: number, ch: string, fg: RGBA) => {
      if (y < viewTop || y > viewBottom) return;
      const xMin = Math.min(xA, xB);
      const xMax = Math.max(xA, xB);
      for (let x = xMin; x <= xMax; x++) setGraphCell(x, y, ch, fg);
    };

    for (let childIdx = 0; childIdx < props.nodes.length; childIdx++) {
      const node = props.nodes[childIdx];
      const lane = node.lane || 0;
      const x0 = laneXCell(lane);
      const y0 = rowYAbs(childIdx);
      const isSelectedNode = !!selectedId && node.changeId === selectedId;
      const color = LANE_COLORS[lane % LANE_COLORS.length];
      // When HIGHLIGHT_NODE_CIRCLE is true, don't brighten colors for selected nodes
      const baseColor = (isSelectedNode && !HIGHLIGHT_NODE_CIRCLE)
        ? RGBA.fromInts(Math.min(255, color.r + 80), Math.min(255, color.g + 80), Math.min(255, color.b + 80), 255)
        : color;

      for (let pIdx = 0; pIdx < node.parents.length; pIdx++) {
        const pid = node.parents[pIdx];
        const pi = indexByIdAll.get(pid);
        if (pi === undefined) continue;
        const parent = props.nodes[pi];
        if (!parent) continue;
        const y1 = rowYAbs(pi);

        // Skip edges that don't touch the visible window at all.
        if (Math.max(y0, y1) < viewTop || Math.min(y0, y1) > viewBottom) continue;

        const pl = parent.lane || 0;
        const x1 = laneXCell(pl);
        const isParentSelected = !!selectedId && parent.changeId === selectedId;
        const isConnectionSelected = isSelectedNode || isParentSelected;
        const pc = LANE_COLORS[pl % LANE_COLORS.length];
        // When HIGHLIGHT_NODE_CIRCLE is true, don't brighten colors for selected nodes
        const parentColor = (isParentSelected && !HIGHLIGHT_NODE_CIRCLE)
          ? RGBA.fromInts(Math.min(255, pc.r + 80), Math.min(255, pc.g + 80), Math.min(255, pc.b + 80), 255)
          : pc;

        if (lane === pl) {
          // When HIGHLIGHT_NODE_CIRCLE is true, don't highlight lines in white
          const lineColor = (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : pc;
          drawVert(x0, y0 + 1, y1 - 1, "│", lineColor);
        } else {
          const isMergeCommit = node.parents.length > 1;
          const connectY = isMergeCommit ? y0 : y1;

          const busSpan = props.layoutMode === "mainline" ? busByY.get(connectY) : undefined;
          const segMinX = Math.min(x0, x1);
          const segMaxX = Math.max(x0, x1);
          const useBus =
            !!busSpan &&
            ((lane === 0) || (pl === 0)) &&
            segMinX >= busSpan.minX &&
            segMaxX <= busSpan.maxX;

          // Horizontal segment on the join row.
          // In mainline mode, the bus provides the full-width horizontal at join points.
          if (!useBus) {
            drawHorz(x0, x1, connectY, "─", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
          }

          if (isMergeCommit) {
            // Merge: horizontal at child row; vertical drops down to the parent lane.
            if (connectY >= viewTop && connectY <= viewBottom) {
              if (x0 < x1) {
                setGraphCell(x0, connectY, "├", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : (isSelectedNode ? baseColor : color));
                setGraphCell(x1, connectY, "┐", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
              } else {
                setGraphCell(x0, connectY, "┤", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : (isSelectedNode ? baseColor : color));
                setGraphCell(x1, connectY, "┌", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
              }
            }

            drawVert(x1, connectY + 1, y1 - 1, "│", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
          } else {
            // Fork: horizontal at parent row; vertical rises up on the child's lane.
            if (connectY >= viewTop && connectY <= viewBottom) {
              if (x0 < x1) {
                setGraphCell(x1, connectY, "├", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
                setGraphCell(x0, connectY, "└", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : (isSelectedNode ? baseColor : color));
              } else {
                setGraphCell(x1, connectY, "┤", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : parentColor);
                setGraphCell(x0, connectY, "┘", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : (isSelectedNode ? baseColor : color));
              }
            }

            drawVert(x0, y0 + 1, connectY - 1, "│", (isConnectionSelected && !HIGHLIGHT_NODE_CIRCLE) ? WHITE : (isSelectedNode ? baseColor : color));
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
        fg = GREEN();
      } else if (node.isWorkingCopy) {
        ch = "@";
        fg = GREEN();
      } else if (node.isConflict) {
        ch = "!";
        fg = RED();
      } else if (node.isEmpty) {
        ch = isSelected ? "0" : "o";
        fg = laneColor;
      }
      // When HIGHLIGHT_NODE_CIRCLE is true, highlight the selected node circle in white
      if (HIGHLIGHT_NODE_CIRCLE && isSelected && !node.isWorkingCopy && !node.isConflict) {
        fg = WHITE;
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
        // Indicator column: @ stays left, > moves right when selected
        if (node.isWorkingCopy && isSelected) {
          // Selected WC: ...@>
          fb.drawText("@", Math.max(0, textX - 3), y, GREEN());
          fb.drawText(">", Math.max(0, textX - 2), y, WHITE);
        } else if (node.isWorkingCopy) {
          // Non-selected WC: ...@
          fb.drawText("@", Math.max(0, textX - 2), y, GREEN());
        } else if (isSelected) {
          // Selected non-WC: ...>
          fb.drawText(">", Math.max(0, textX - 2), y, WHITE);
        }
        
        // Change ID - line 1 (top line gets full white when selected)
        fb.drawText(changeShort, textX, y, isSelected ? WHITE : laneColor);
        fb.drawText(" ", textX + 8, y, laneColor);
        
        // Commit ID - line 1 (top line gets full white when selected)
        fb.drawText(commitShort, textX + 9, y, isSelected ? WHITE : RGBA.fromHex(graphColorsHex.commitId()));
        
        // Description - line 2 (brighter version when selected, not full white)
        const descColor = isSelected ? brighten(graphColorsHex.fg()) : RGBA.fromHex(graphColorsHex.fg());
        fb.drawText(desc, textX, y + 1, descColor);

        // Bookmarks - line 2 (brighter bookmark color when selected)
        if (node.bookmarks.length > 0) {
          const bm = ` (${node.bookmarks.join(",")})`;
          const bmColor = isSelected ? brighten(graphColorsHex.bookmark()) : RGBA.fromHex(graphColorsHex.bookmark());
          fb.drawText(truncate(bm, Math.max(0, w - (textX + desc.length) - 1)), textX + Math.min(desc.length, descMax), y + 1, bmColor);
        }

        // Files - line 3 (brighter per-type colors when selected)
        const filesCached = props.filesCache.get(node.changeId);
        if (filesCached && filesCached.files.length > 0) {
          const fileMaxW = Math.max(0, w - textX - 2);
          let currentX = textX;
          const filesToShow = filesCached.files.slice(0, 3);
          
          for (let fi = 0; fi < filesToShow.length; fi++) {
            const f = filesToShow[fi]!;
            const fileName = f.path.split("/").pop() || f.path;
            const fileText = `${f.type}:${fileName}`;
            const isLast = fi === filesToShow.length - 1;
            
            // Color code by file change type, with brightening for selected
            let fileColor;
            if (f.type === "A") fileColor = isSelected ? brighten(graphColorsHex.fileAdd()) : RGBA.fromHex(graphColorsHex.fileAdd());
            else if (f.type === "D") fileColor = isSelected ? brighten(graphColorsHex.fileDel()) : RGBA.fromHex(graphColorsHex.fileDel());
            else fileColor = isSelected ? brighten(graphColorsHex.fileMod()) : RGBA.fromHex(graphColorsHex.fileMod());
            
            fb.drawText(fileText, currentX, y + 2, fileColor);
            currentX += fileText.length;
            
            if (!isLast) {
              const sepColor = isSelected ? brighten(graphColorsHex.fg(), 40) : RGBA.fromHex(graphColorsHex.fg());
              fb.drawText(" ", currentX, y + 2, sepColor);
              currentX += 1;
            }
          }
          
          if (filesCached.files.length > 3) {
            const moreText = ` +${filesCached.files.length - 3}`;
            const moreColor = isSelected ? brighten(graphColorsHex.textMuted(), 40) : RGBA.fromHex(graphColorsHex.textMuted());
            fb.drawText(moreText, currentX, y + 2, moreColor);
          }
        } else if (filesCached) {
          const noFilesColor = isSelected ? brighten(graphColorsHex.textMuted(), 40) : RGBA.fromHex(graphColorsHex.textMuted());
          fb.drawText("(no files)", textX, y + 2, noFilesColor);
        }
      }
    }

    if (canvas.hasSelection()) {
      const raw = Buffer.from(canvas.frameBuffer.getRealCharBytes(true)).toString("utf8");
      graphLines = raw.split("\n").slice(0, h).map((line) => line.slice(0, w));
    } else if (graphLines.length > 0) {
      graphLines = [];
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
    
    tryCreateCanvas();
  };

  createEffect(() => {
    // Re-render when any of these change
    props.nodes;
    props.selectedId;
    props.scrollOffset;
    props.filesCache;
    props.width;
    props.height;
    props.themeVersion;

    if (!canvas && parentBox) {
      tryCreateCanvas();
    }
    
    if (canvas && parentBox) {
      const nextW = props.width;
      const nextH = props.height;
      const currentW = (canvas as any).width as number;
      const currentH = (canvas as any).height as number;
      if (currentW !== nextW) (canvas as any).width = nextW;
      if (currentH !== nextH) (canvas as any).height = nextH;
      if (nextW > 0 && nextH > 0) {
        canvas.frameBuffer.fillRect(0, 0, nextW, nextH, BG());
      }
      draw();
    }
  });

  return <box ref={setupCanvas} width={props.width} height={props.height} backgroundColor={viewBg()} />;
}
