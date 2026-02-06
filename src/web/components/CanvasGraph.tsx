import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { actions, state, layoutResult } from "../../core/state";
import { webActions, webState } from "../../core/state-web";
import type { CommitNode } from "../../core/types";
import { DEFAULT_GRAPH_CONFIG } from "../../core/types";
import { findConnectionAt, findNodeAt, getLaneColor } from "../../core/layout";
import { UI_TOKENS } from "../../core/ui-tokens";

type DropTarget =
  | { type: "commit"; node: CommitNode }
  | { type: "lane"; lane: number };

export function CanvasGraph(props: {
  onMoveCommit: (sourceId: string, destinationId: string) => void;
  onInsertBetween: (parentId: string, childId: string) => void;
  onInsertAfter: (afterId: string) => void;
  onRebase: (sourceId: string, destinationId: string) => void;
  onToggleInlineFiles: () => void;
  onInlineAction: (action: "new" | "edit" | "describe" | "rebase" | "files" | "abandon" | "duplicate" | "squash", nodeId: string) => void;
}) {
  let canvasRef: HTMLCanvasElement | undefined;
  let containerRef: HTMLDivElement | undefined;

  const [dimensions, setDimensions] = createSignal({ width: 800, height: 600 });
  const [isPanning, setIsPanning] = createSignal(false);
  const [dragStart, setDragStart] = createSignal({ x: 0, y: 0 });
  const [dragNodeId, setDragNodeId] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);
  const [hoveredConn, setHoveredConn] = createSignal<{ from: string; to: string; midX: number; midY: number } | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = createSignal<string | null>(null);
  const [shiftActive, setShiftActive] = createSignal(false);

  const cfg = DEFAULT_GRAPH_CONFIG;

  type InlineBtn = { x: number; y: number; w: number; h: number; action: Parameters<typeof props.onInlineAction>[0]; nodeId: string };
  let inlineButtons: InlineBtn[] = [];

  const worldPoint = (clientX: number, clientY: number) => {
    if (!canvasRef) return { x: 0, y: 0 };
    const rect = canvasRef.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    return {
      x: (x - webState.viewport.offsetX) / webState.viewport.scale,
      y: (y - webState.viewport.offsetY) / webState.viewport.scale,
    };
  };

  const detectDropTarget = (wx: number, wy: number, sourceId: string): DropTarget | null => {
    const nodes = layoutResult().nodes;

    const targetNode = findNodeAt(wx, wy, nodes, cfg);
    if (targetNode && targetNode.changeId !== sourceId) {
      return { type: "commit", node: targetNode };
    }

    const maxLane = layoutResult().maxLane;
    const laneFloat = maxLane - ((wx - cfg.canvasPadding) / cfg.laneWidth);
    const lane = Math.max(0, Math.round(laneFloat));
    return { type: "lane", lane };
  };

  const drawPill = (ctx: CanvasRenderingContext2D, x: number, y: number, text: string, fg: string, bg: string, border: string) => {
    ctx.font = '10px Inter, sans-serif';
    const w = ctx.measureText(text).width + 12;
    ctx.fillStyle = bg;
    ctx.fillRect(x, y, w, 16);
    ctx.strokeStyle = border;
    ctx.lineWidth = 1;
    ctx.strokeRect(x, y, w, 16);
    ctx.fillStyle = fg;
    ctx.fillText(text, x + 6, y + 12);
    return w + 5;
  };

  const render = () => {
    if (!canvasRef) return;
    const ctx = canvasRef.getContext("2d");
    if (!ctx) return;

    canvasRef.width = Math.floor(dimensions().width);
    canvasRef.height = Math.floor(dimensions().height);

    ctx.clearRect(0, 0, canvasRef.width, canvasRef.height);
    // Keep canvas mostly transparent so the dot-board (CSS) reads through.
    // Neutral slate tint keeps the dot-board visible but not dominant.
    ctx.fillStyle = UI_TOKENS.graph.canvasTint;
    ctx.fillRect(0, 0, canvasRef.width, canvasRef.height);

    const nodes = layoutResult().nodes;
    if (nodes.length === 0) {
      ctx.fillStyle = UI_TOKENS.slate.textMuted;
      ctx.font = '14px "JetBrains Mono", monospace';
      ctx.fillText("No commits loaded. Press 'r' to refresh.", 20, 30);
      return;
    }

    ctx.save();
    ctx.translate(webState.viewport.offsetX, webState.viewport.offsetY);
    ctx.scale(webState.viewport.scale, webState.viewport.scale);

    inlineButtons = [];

    // Lane guides during drag
    const draggingId = dragNodeId();
    if (draggingId) {
      const maxLane = layoutResult().maxLane;
      const dt = dropTarget();
      ctx.save();
      ctx.globalAlpha = 0.25;
      for (let lane = 0; lane <= maxLane + 2; lane++) {
        const x = cfg.canvasPadding + ((maxLane - lane) * cfg.laneWidth);
        ctx.beginPath();
        ctx.moveTo(x, -1000);
        ctx.lineTo(x, 100000);
        const isLaneHover = dt?.type === "lane" && dt.lane === lane;
        ctx.strokeStyle = isLaneHover ? UI_TOKENS.semantic.success : UI_TOKENS.slate.borderSoft;
        ctx.lineWidth = isLaneHover ? 3 : 1;
        ctx.setLineDash(isLaneHover ? [] : [6, 6]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.restore();
    }

    // Connections
    nodes.forEach((node) => {
      node.parents.forEach((parentId, idx) => {
        const parent = nodes.find((n) => n.changeId === parentId);
        if (!parent || parent.x === undefined || parent.y === undefined || node.x === undefined || node.y === undefined) return;

        const color = getLaneColor(node.lane === parent.lane ? (node.lane || 0) : (parent.lane || 0), cfg);
        const yOffset = idx * 3;
        const startX = node.x;
        const startY = node.y + cfg.nodeRadius + 4 + yOffset;
        const targetX = parent.x;
        const targetY = parent.y - cfg.nodeRadius - 4;

        ctx.save();
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        if (node.lane === parent.lane) {
          ctx.lineTo(targetX, targetY);
        } else {
          const radius = 10;
          const direction = targetX > startX ? 1 : -1;
          const cornerX = targetX - radius * direction;
          const isMergeCommit = node.parents.length > 1;

          if (isMergeCommit) {
            // Keep the original merge join near the merge commit.
            if (Math.abs(targetX - startX) < radius * 2) {
              ctx.lineTo(targetX, startY);
              ctx.lineTo(targetX, targetY);
            } else {
              ctx.lineTo(cornerX, startY);
              ctx.quadraticCurveTo(targetX, startY, targetX, startY + radius);
              ctx.lineTo(targetX, targetY);
            }
          } else {
            // Fork/branch: junction near the parent so it reads as branching from the parent,
            // not from the first child.
            const down = targetY >= startY;
            let joinY = down ? targetY - radius : targetY + radius;
            if (down && joinY < startY + radius) joinY = startY + radius;
            if (!down && joinY > startY - radius) joinY = startY - radius;

            ctx.lineTo(startX, joinY);
            if (Math.abs(targetX - startX) < radius * 2) {
              ctx.lineTo(targetX, joinY);
              ctx.lineTo(targetX, targetY);
            } else {
              ctx.lineTo(cornerX, joinY);
              ctx.quadraticCurveTo(targetX, joinY, targetX, joinY + (down ? radius : -radius));
              ctx.lineTo(targetX, targetY);
            }
          }
        }
        ctx.stroke();
        ctx.restore();
      });
    });

    // Nodes + labels + pills + inline files
    nodes.forEach((node) => {
      if (node.x === undefined || node.y === undefined) return;

      const isSelected = state.selectedIds.has(node.changeId);
      const laneColor = getLaneColor(node.lane || 0, cfg);

      // Move-mode target indicator
      if (webState.opMode === "move" && webState.opTargetId && webState.opTargetId === node.changeId) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(node.x, node.y, cfg.nodeRadius + 10, 0, Math.PI * 2);
        ctx.strokeStyle = UI_TOKENS.semantic.success;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 5]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      }

      // Node circle
      ctx.beginPath();
      ctx.arc(node.x, node.y, cfg.nodeRadius + (isSelected ? 3 : 0), 0, Math.PI * 2);
      ctx.fillStyle = node.isConflict ? UI_TOKENS.semantic.error : UI_TOKENS.slate.bg0;
      ctx.strokeStyle = isSelected ? UI_TOKENS.slate.text : laneColor;
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.fill();
      ctx.stroke();

      // Connector to text column
      if (layoutResult().textColumnX) {
        ctx.beginPath();
        ctx.setLineDash([2, 4]);
        ctx.moveTo(node.x + cfg.nodeRadius + 2, node.y);
        ctx.lineTo(layoutResult().textColumnX - 10, node.y);
        ctx.strokeStyle = laneColor;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Pills (bookmarks/branches)
      const localBookmarks = (node.bookmarks || []).filter((b) => !b.includes("@"));
      const trackedBookmarks = (node.bookmarks || []).filter((b) => b.includes("@"));
      const allRefs = [...localBookmarks, ...trackedBookmarks, ...(node.gitBranches || [])];
      if (allRefs.length > 0) {
        let pillX = layoutResult().textColumnX;
        // Keep pills clearly above the header line (avoid font ascender overlap).
        const pillY = node.y - 36;
        localBookmarks.forEach((b) => {
          pillX += drawPill(ctx, pillX, pillY, b, UI_TOKENS.semantic.info, "rgba(127, 159, 191, 0.14)", UI_TOKENS.semantic.info);
        });
        trackedBookmarks.forEach((b) => {
          pillX += drawPill(ctx, pillX, pillY, b, UI_TOKENS.slate.text, "rgba(138, 149, 167, 0.16)", UI_TOKENS.slate.borderStrong);
        });
        (node.gitBranches || []).forEach((b) => {
          pillX += drawPill(ctx, pillX, pillY, b, UI_TOKENS.semantic.warn, "rgba(201, 168, 106, 0.16)", UI_TOKENS.semantic.warn);
        });
      }

      // Text column
      ctx.fillStyle = isSelected ? UI_TOKENS.slate.text : UI_TOKENS.slate.textMuted;
      ctx.font = 'bold 12px "JetBrains Mono", monospace';
      if (node.isWorkingCopy) {
        ctx.fillStyle = UI_TOKENS.semantic.success;
        ctx.fillText("@", layoutResult().textColumnX - 15, node.y + 4);
        ctx.fillStyle = isSelected ? UI_TOKENS.slate.text : UI_TOKENS.semantic.success;
      }
      ctx.fillText(node.changeId.substring(0, 8), layoutResult().textColumnX, node.y + 4);
      ctx.fillStyle = UI_TOKENS.slate.text;
      ctx.font = '12px Inter, sans-serif';
      const desc = (node.descriptionTitle || "").slice(0, 60);
      ctx.fillText(desc, layoutResult().textColumnX + 80, node.y + 4);

      // Inline controls (selected or hovered node; Shift shows alternate actions)
      // Position BELOW the description text (user requested: underneath, not next to)
      const isHovered = hoveredNodeId() === node.changeId;
      if (isSelected || isHovered) {
        const showAlt = shiftActive();
        // Position buttons below the main text row
        const baseX = layoutResult().textColumnX;
        const baseY = node.y + 12; // Below the text which is at node.y + 4
        const items: Array<{ label: string; action: InlineBtn["action"] }> = showAlt
          ? [
              { label: "Abandon", action: "abandon" },
              { label: "Squash", action: "squash" },
              { label: "Dupe", action: "duplicate" },
            ]
          : [
              { label: "Edit", action: "edit" },
              { label: "New", action: "new" },
              { label: "Desc", action: "describe" },
              { label: "Rebase", action: "rebase" },
              { label: "Files", action: "files" },
            ];

        let x = baseX;
        const y = baseY;
        ctx.save();
        ctx.font = '11px Inter, sans-serif';
        items.forEach((it) => {
          const w = ctx.measureText(it.label).width + 18;
          const h = 18;
          ctx.fillStyle = "rgba(22, 27, 34, 0.78)";
          ctx.strokeStyle = "rgba(58, 71, 89, 0.9)";
          ctx.lineWidth = 1;
          ctx.beginPath();
          // @ts-ignore - roundRect exists on modern canvases
          if (ctx.roundRect) ctx.roundRect(x, y, w, h, 9);
          else ctx.rect(x, y, w, h);
          ctx.fill();
          ctx.stroke();

          ctx.fillStyle = UI_TOKENS.slate.text;
          ctx.fillText(it.label, x + 9, y + 13);
          inlineButtons.push({ x, y, w, h, action: it.action, nodeId: node.changeId });
          x += w + 8;
        });
        ctx.restore();
      }

      // Inline files - positioned below inline controls (or below text if no controls)
      if (webState.expandedFilesNodeId === node.changeId) {
        const cached = state.filesCache.get(node.changeId);
        if (cached && cached.files.length > 0) {
          // Start below inline controls (baseY + 18 + spacing) or just below text row
          const hasControls = isSelected || isHovered;
          let y = hasControls ? node.y + 50 : node.y + 30;
          const x = layoutResult().textColumnX + 20;
          ctx.font = '11px "JetBrains Mono", monospace';
          cached.files.forEach((f) => {
            const typeColor = f.type === "A"
              ? UI_TOKENS.semantic.fileAdd
              : f.type === "D"
                ? UI_TOKENS.semantic.fileDel
                : UI_TOKENS.semantic.fileMod;
            ctx.fillStyle = typeColor;
            ctx.fillText(f.type, x, y);
            ctx.fillStyle = UI_TOKENS.slate.textMuted;
            ctx.fillText(f.path, x + 20, y);
            y += 14;
          });
        }
      }
    });

    // Hovered connection indicator
    const hc = hoveredConn();
    if (hc) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(hc.midX, hc.midY, 6, 0, Math.PI * 2);
      ctx.fillStyle = UI_TOKENS.semantic.info;
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(hc.midX - 3, hc.midY);
      ctx.lineTo(hc.midX + 3, hc.midY);
      ctx.moveTo(hc.midX, hc.midY - 3);
      ctx.lineTo(hc.midX, hc.midY + 3);
      ctx.strokeStyle = UI_TOKENS.slate.bg0;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = UI_TOKENS.semantic.info;
      ctx.font = '10px Inter, sans-serif';
      ctx.fillText("Alt+click to insert", hc.midX + 12, hc.midY + 3);
      ctx.restore();
    }

    // Drag toast
    if (draggingId) {
      const dragNode = nodes.find((n) => n.changeId === draggingId);
      if (dragNode && dragNode.x !== undefined && dragNode.y !== undefined) {
        ctx.save();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "rgba(127, 159, 191, 0.9)";
        ctx.fillRect(20, 20, 420, 50);
        ctx.fillStyle = "#000";
        ctx.font = 'bold 14px Inter, sans-serif';
        ctx.fillText(`Dragging ${dragNode.changeId.slice(0, 8)}`, 30, 42);
        ctx.font = '12px Inter, sans-serif';
        const dt = dropTarget();
        const hint = dt?.type === "commit"
          ? `Drop on ${dt.node.changeId.slice(0, 8)} to move (rebase)`
          : dt?.type === "lane"
            ? `Drop to pin lane ${dt.lane}`
            : "Drop on commit to move; on lane to pin";
        ctx.fillText(hint, 30, 62);
        ctx.restore();
      }
    }

    ctx.restore();
  };

  const handleMouseDown = (e: MouseEvent) => {
    if (!canvasRef) return;
    const { x: wx, y: wy } = worldPoint(e.clientX, e.clientY);

    // Inline button hit test (world coords)
    for (const b of inlineButtons) {
      if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) {
        props.onInlineAction(b.action, b.nodeId);
        return;
      }
    }
    const nodes = layoutResult().nodes;

    const hitNode = findNodeAt(wx, wy, nodes, cfg);
    if (hitNode) {
      // Rebase click-to-target mode
      if (state.rebaseSourceId && state.rebaseSourceId !== hitNode.changeId) {
        props.onRebase(state.rebaseSourceId, hitNode.changeId);
        return;
      }

      // Move-mode target selection (doesn't change selection)
      if (webState.opMode === "move" && state.selectedIds.size === 1 && state.selectedId && hitNode.changeId !== state.selectedId) {
        webActions.setOpTarget(hitNode.changeId);
        return;
      }

      // Selection
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        webActions.resetOpMode();
        actions.toggleSelection(hitNode.changeId);
      } else {
        webActions.resetOpMode();
        actions.selectNode(hitNode.changeId);
      }

      // Alt+drag begins drag-to-pin/move
      if (e.altKey) {
        setDragNodeId(hitNode.changeId);
        setDropTarget(detectDropTarget(wx, wy, hitNode.changeId));
        return;
      }

      return;
    }

    // Start panning
    setIsPanning(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!canvasRef) return;

    const dragging = dragNodeId();
    const { x: wx, y: wy } = worldPoint(e.clientX, e.clientY);

    if (dragging) {
      setHoveredConn(null);
      setDropTarget(detectDropTarget(wx, wy, dragging));
      render();
      return;
    }

    if (isPanning()) {
      const dx = e.clientX - dragStart().x;
      const dy = e.clientY - dragStart().y;
      webActions.setViewport({
        offsetX: webState.viewport.offsetX + dx,
        offsetY: webState.viewport.offsetY + dy,
      });
      setDragStart({ x: e.clientX, y: e.clientY });
      return;
    }

    // Hover connection
    const conn = findConnectionAt(wx, wy, layoutResult().nodes, cfg);
    if (conn) {
      const startX = conn.to.x!;
      const startY = conn.to.y! + cfg.nodeRadius + 4;
      const targetX = conn.from.x!;
      const targetY = conn.from.y! - cfg.nodeRadius - 4;
      setHoveredConn({
        from: conn.from.changeId,
        to: conn.to.changeId,
        midX: (startX + targetX) / 2,
        midY: (startY + targetY) / 2,
      });
      render();
    } else if (hoveredConn()) {
      setHoveredConn(null);
      render();
    }

    // Hover node detection for inline controls - use Y-threshold for entire row
    // This allows hovering over description, bookmarks, or anywhere on the row
    const HOVER_THRESHOLD_Y = Math.min(cfg.ySpacing / 2, 38);
    const foundNode = layoutResult().nodes.find((n) => 
      n.y !== undefined && Math.abs(n.y - wy) < HOVER_THRESHOLD_Y
    );
    if (foundNode) {
      if (hoveredNodeId() !== foundNode.changeId) {
        setHoveredNodeId(foundNode.changeId);
        render();
      }
    } else if (hoveredNodeId()) {
      setHoveredNodeId(null);
      render();
    }
  };

  const handleMouseUp = () => {
    setIsPanning(false);

    const dragging = dragNodeId();
    if (!dragging) return;

    const dt = dropTarget();
    if (dt?.type === "commit") {
      props.onMoveCommit(dragging, dt.node.changeId);
    } else if (dt?.type === "lane") {
      actions.pinNode(dragging, dt.lane);
    }

    setDragNodeId(null);
    setDropTarget(null);
  };

  const handleWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (!canvasRef) return;
    const rect = canvasRef.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.1, Math.min(3, webState.viewport.scale * zoomFactor));
    const scaleRatio = newScale / webState.viewport.scale;
    const newOffsetX = x - (x - webState.viewport.offsetX) * scaleRatio;
    const newOffsetY = y - (y - webState.viewport.offsetY) * scaleRatio;

    webActions.setViewport({
      scale: newScale,
      offsetX: newOffsetX,
      offsetY: newOffsetY,
    });
  };

  const handleClick = (e: MouseEvent) => {
    if (!e.altKey) return;
    const hc = hoveredConn();
    if (!hc) return;
    props.onInsertBetween(hc.from, hc.to);
  };

  const handleContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    const { x: wx, y: wy } = worldPoint(e.clientX, e.clientY);
    const hitNode = findNodeAt(wx, wy, layoutResult().nodes, cfg);
    if (!hitNode) return;
    if (state.pinnedNodes.has(hitNode.changeId)) {
      actions.unpinNode(hitNode.changeId);
    } else {
      actions.pinNode(hitNode.changeId, hitNode.lane || 0);
    }
  };

  onMount(() => {
    if (!containerRef || !canvasRef) return;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height });
      }
    });
    resizeObserver.observe(containerRef);

    canvasRef.addEventListener("mousedown", handleMouseDown);
    canvasRef.addEventListener("mousemove", handleMouseMove);
    canvasRef.addEventListener("mouseup", handleMouseUp);
    canvasRef.addEventListener("mouseleave", handleMouseUp);
    canvasRef.addEventListener("wheel", handleWheel, { passive: false });
    canvasRef.addEventListener("click", handleClick);
    canvasRef.addEventListener("contextmenu", handleContextMenu);

    // Track shift key state for inline actions
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftActive(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Shift") setShiftActive(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    onCleanup(() => {
      resizeObserver.disconnect();
      canvasRef?.removeEventListener("mousedown", handleMouseDown);
      canvasRef?.removeEventListener("mousemove", handleMouseMove);
      canvasRef?.removeEventListener("mouseup", handleMouseUp);
      canvasRef?.removeEventListener("mouseleave", handleMouseUp);
      canvasRef?.removeEventListener("wheel", handleWheel);
      canvasRef?.removeEventListener("click", handleClick);
      canvasRef?.removeEventListener("contextmenu", handleContextMenu);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    });
  });

  createEffect(() => {
    // Dependencies
    layoutResult().nodes;
    state.selectedIds;
    webState.viewport;
    state.layoutMode;
    webState.expandedFilesNodeId;
    state.filesCache;
    dragNodeId();
    dropTarget();
    hoveredConn();
    hoveredNodeId();
    shiftActive();
    dimensions();
    render();
  });

  return (
    <div ref={(el) => (containerRef = el)} class="jjv-canvasWrap">
      <canvas ref={(el) => (canvasRef = el)} class="jjv-canvas" />
    </div>
  );
}
