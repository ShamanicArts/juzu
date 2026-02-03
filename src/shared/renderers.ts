import type { CommitNode, GraphConfig } from "../core/types";

export interface RenderContext {
  // Drawing primitives
  clear(): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
  
  // Paths
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number): void;
  stroke(): void;
  fill(): void;
  
  // Styles
  setStrokeStyle(color: string): void;
  setFillStyle(color: string): void;
  setLineWidth(width: number): void;
  setLineDash(segments: number[]): void;
  setFont(font: string): void;
  setTextAlign(align: CanvasTextAlign): void;
  setGlobalAlpha(alpha: number): void;
  
  // Text
  fillText(text: string, x: number, y: number, maxWidth?: number): void;
  measureText(text: string): { width: number };
  
  // Rectangles
  fillRect(x: number, y: number, w: number, h: number): void;
  strokeRect(x: number, y: number, w: number, h: number): void;
  roundRect(x: number, y: number, w: number, h: number, radii: number | number[]): void;
  
  // Hit regions (for interaction)
  addHitRegion(region: HitRegion): void;
  clearHitRegions(): void;
  findHitRegion(x: number, y: number): HitRegion | null;
}

export interface HitRegion {
  x: number;
  y: number;
  w: number;
  h: number;
  type: "node" | "connection" | "button" | "lane" | "text";
  data?: unknown;
  cursor?: string;
  onClick?: () => void;
  onHover?: (isHovering: boolean) => void;
}

export interface GraphRenderer {
  // Core properties
  config: GraphConfig;
  nodes: CommitNode[];
  selectedIds: Set<string>;
  
  // Viewport
  offsetX: number;
  offsetY: number;
  scale: number;
  
  // Hit regions for interaction
  hitRegions: HitRegion[];
  
  // Render the entire graph
  render(ctx: RenderContext): void;
  
  // Individual element renderers
  renderNode(ctx: RenderContext, node: CommitNode): void;
  renderConnection(ctx: RenderContext, from: CommitNode, to: CommitNode, parentIndex: number): void;
  renderLaneGuides(ctx: RenderContext, maxLane: number, dragLane?: number | null): void;
  renderTextColumn(ctx: RenderContext, node: CommitNode, textColumnX: number): void;
  renderBookmarks(ctx: RenderContext, node: CommitNode, textColumnX: number): void;
  renderInlineFiles(ctx: RenderContext, node: CommitNode, files: Array<{ type: string; path: string }>): void;
  
  // Drag/Preview renderers
  renderDragPreview(ctx: RenderContext, dragNode: CommitNode, dropTarget?: HitRegion | null): void;
  renderConnectionHoverIndicator(ctx: RenderContext, midX: number, midY: number): void;
}

export function getLaneColor(index: number, config: GraphConfig): string {
  return config.colors.lanes[index % config.colors.lanes.length];
}

export function calculateConnectionPath(
  from: CommitNode,
  to: CommitNode,
  config: GraphConfig
): { path: string; midX: number; midY: number } {
  const OFFSET_STEP = 3;
  const startX = to.x!;
  const startY = to.y! + config.nodeRadius + 4;
  const targetX = from.x!;
  const targetY = from.y! - config.nodeRadius - 4;

  let midX = startX;
  let midY = (startY + targetY) / 2;

  if (to.lane === from.lane) {
    midX = (startX + targetX) / 2;
    return {
      path: `M ${startX} ${startY} L ${targetX} ${targetY}`,
      midX,
      midY,
    };
  } else {
    const radius = 10;
    const direction = targetX > startX ? 1 : -1;
    const cornerX = targetX - radius * direction;

    if (Math.abs(targetX - startX) < radius * 2) {
      midX = (startX + targetX) / 2;
      return {
        path: `M ${startX} ${startY} L ${targetX} ${startY} L ${targetX} ${targetY}`,
        midX,
        midY,
      };
    } else {
      midX = (cornerX + targetX) / 2;
      return {
        path: `M ${startX} ${startY} L ${cornerX} ${startY} Q ${targetX} ${startY} ${targetX} ${startY + radius} L ${targetX} ${targetY}`,
        midX,
        midY,
      };
    }
  }
}

export function createGraphRenderer(
  nodes: CommitNode[],
  config: GraphConfig,
  options: {
    selectedIds?: Set<string>;
    dragNode?: CommitNode | null;
    dropTarget?: HitRegion | null;
    hoveredConnection?: { from: string; to: string } | null;
    expandedFilesNode?: string | null;
    filesCache?: Map<string, Array<{ type: string; path: string }>>;
  } = {}
): GraphRenderer {
  return {
    config,
    nodes,
    selectedIds: options.selectedIds || new Set(),
    offsetX: 0,
    offsetY: 0,
    scale: 1,
    hitRegions: [],

    render(ctx: RenderContext) {
      ctx.clear();
      ctx.save();
      ctx.translate(this.offsetX, this.offsetY);
      ctx.scale(this.scale, this.scale);
      
      ctx.clearHitRegions();

      // Draw lane guides if dragging
      if (options.dragNode) {
        const maxLane = Math.max(0, ...this.nodes.map((n) => n.lane || 0));
        this.renderLaneGuides(ctx, maxLane, options.dropTarget?.type === "lane" ? (options.dropTarget.data as number) : null);
      }

      // Draw connections
      this.nodes.forEach((node) => {
        node.parents.forEach((parentId, idx) => {
          const parent = this.nodes.find((n) => n.changeId === parentId);
          if (parent) {
            this.renderConnection(ctx, parent, node, idx);
          }
        });
      });

      // Draw drag preview
      if (options.dragNode) {
        this.renderDragPreview(ctx, options.dragNode, options.dropTarget);
      }

      // Draw nodes
      this.nodes.forEach((node) => this.renderNode(ctx, node));

      // Draw hovered connection indicator
      if (options.hoveredConnection) {
        // Find the connection midpoint
        const parent = this.nodes.find((n) => n.changeId === options.hoveredConnection!.from);
        const child = this.nodes.find((n) => n.changeId === options.hoveredConnection!.to);
        if (parent && child) {
          const { midX, midY } = calculateConnectionPath(parent, child, this.config);
          this.renderConnectionHoverIndicator(ctx, midX, midY);
        }
      }

      ctx.restore();
    },

    renderNode(ctx: RenderContext, node: CommitNode) {
      const isSelected = this.selectedIds.has(node.changeId);
      const isDragged = options.dragNode?.changeId === node.changeId;
      const color = getLaneColor(node.lane || 0, this.config);

      // Draw node circle
      ctx.beginPath();
      ctx.arc(node.x!, node.y!, this.config.nodeRadius + (isSelected ? 3 : 0), 0, Math.PI * 2);

      if (isDragged) {
        ctx.setGlobalAlpha(0.3);
        ctx.setFillStyle("#1a1a1a");
        ctx.setStrokeStyle("rgba(0, 240, 255, 0.5)");
        ctx.setLineDash([3, 3]);
      } else {
        ctx.setGlobalAlpha(1);
        ctx.setFillStyle(node.isConflict ? this.config.colors.nodeConflict : "#1a1a1a");
        ctx.setStrokeStyle(isSelected ? this.config.colors.nodeSelected : color);
        ctx.setLineDash([]);
      }

      ctx.fill();
      ctx.setLineWidth(isSelected ? 3 : 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.setGlobalAlpha(1);

      // Pin indicator
      if (node.isPinned) {
        ctx.beginPath();
        ctx.arc(node.x! + this.config.nodeRadius + 4, node.y! - this.config.nodeRadius - 4, 3, 0, Math.PI * 2);
        ctx.setFillStyle("#ffa500");
        ctx.fill();
      }

      // Add hit region for node
      ctx.addHitRegion({
        x: node.x! - this.config.nodeRadius - 5,
        y: node.y! - this.config.nodeRadius - 5,
        w: this.config.nodeRadius * 2 + 10,
        h: this.config.nodeRadius * 2 + 10,
        type: "node",
        data: node,
        cursor: "pointer",
      });
    },

    renderConnection(ctx: RenderContext, from: CommitNode, to: CommitNode, parentIndex: number) {
      const color = getLaneColor(to.lane === from.lane ? to.lane! : from.lane!, this.config);
      
      ctx.save();
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(2);
      
      // Draw the connection path
      ctx.beginPath();
      
      const OFFSET_STEP = 3;
      const yOffset = parentIndex * OFFSET_STEP;
      const startX = to.x!;
      const startY = to.y! + this.config.nodeRadius + 4 + yOffset;
      const targetX = from.x!;
      const targetY = from.y! - this.config.nodeRadius - 4;

      ctx.moveTo(startX, startY);

      if (to.lane === from.lane) {
        ctx.lineTo(targetX, targetY);
      } else {
        const radius = 10;
        const direction = targetX > startX ? 1 : -1;
        const cornerX = targetX - radius * direction;

        if (Math.abs(targetX - startX) < radius * 2) {
          ctx.lineTo(targetX, startY);
          ctx.lineTo(targetX, targetY);
        } else {
          ctx.lineTo(cornerX, startY);
          ctx.quadraticCurveTo(targetX, startY, targetX, startY + radius);
          ctx.lineTo(targetX, targetY);
        }
      }
      
      ctx.stroke();
      ctx.restore();

      // Add hit region for connection
      const midX = (startX + targetX) / 2;
      const midY = (startY + targetY) / 2;
      ctx.addHitRegion({
        x: Math.min(startX, targetX) - 10,
        y: Math.min(startY, targetY),
        w: Math.abs(targetX - startX) + 20,
        h: Math.abs(targetY - startY),
        type: "connection",
        data: { from: from.changeId, to: to.changeId, midX, midY },
        cursor: "crosshair",
      });
    },

    renderLaneGuides(ctx: RenderContext, maxLane: number, dragLane: number | null = null) {
      ctx.save();
      ctx.setGlobalAlpha(0.3);

      for (let lane = 0; lane <= maxLane + 2; lane++) {
        const x = this.config.canvasPadding + ((maxLane - lane) * this.config.laneWidth);

        ctx.beginPath();
        ctx.moveTo(x, -1000);
        ctx.lineTo(x, 10000);
        ctx.setStrokeStyle(lane === dragLane ? "#00ff9d" : "#444");
        ctx.setLineWidth(lane === dragLane ? 3 : 1);
        ctx.setLineDash(lane === dragLane ? [] : [5, 5]);
        ctx.stroke();

        ctx.setFillStyle(lane === dragLane ? "#00ff9d" : "#666");
        ctx.setFont("10px monospace");
        ctx.fillText(`L${lane}`, x + 3, 30);
      }

      ctx.restore();
    },

    renderTextColumn(ctx: RenderContext, node: CommitNode, textColumnX: number) {
      const isSelected = this.selectedIds.has(node.changeId);
      const color = getLaneColor(node.lane || 0, this.config);

      // Draw dotted connector to text
      ctx.save();
      ctx.beginPath();
      ctx.setLineDash([2, 4]);
      ctx.moveTo(node.x! + this.config.nodeRadius + 2, node.y!);
      ctx.lineTo(textColumnX - 10, node.y!);
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(1);
      ctx.stroke();
      ctx.restore();

      // Working copy indicator
      if (node.isWorkingCopy) {
        ctx.setFillStyle("#00ff9d");
        ctx.setFont("bold 12px monospace");
        ctx.fillText("@", textColumnX - 15, node.y! + 4);
      }

      // Change ID
      ctx.setFillStyle(isSelected ? "#fff" : this.config.colors.text);
      ctx.setFont("bold 12px monospace");
      ctx.fillText(node.changeId.substring(0, 8), textColumnX, node.y! + 4);

      // Description
      ctx.setFillStyle(this.config.colors.textDesc);
      ctx.setFont("12px sans-serif");
      let desc = node.descriptionTitle;
      if (desc.length > 50) desc = desc.substring(0, 47) + "...";
      ctx.fillText(desc, textColumnX + 80, node.y! + 4);
    },

    renderBookmarks(ctx: RenderContext, node: CommitNode, textColumnX: number) {
      const allRefs = [...node.bookmarks, ...node.gitBranches];
      if (allRefs.length === 0) return;

      let pillX = textColumnX;
      const pillY = node.y! - 22;

      // JJ bookmarks
      node.bookmarks.forEach((bookmark) => {
        ctx.setFont("10px sans-serif");
        const metrics = ctx.measureText(bookmark);
        const pillWidth = metrics.width + 12;

        ctx.setFillStyle("rgba(0, 240, 255, 0.15)");
        ctx.fillRect(pillX, pillY, pillWidth, 16);
        ctx.setStrokeStyle("#00f0ff");
        ctx.setLineWidth(1);
        ctx.strokeRect(pillX, pillY, pillWidth, 16);

        ctx.setFillStyle("#00f0ff");
        ctx.fillText(bookmark, pillX + 6, pillY + 12);

        pillX += pillWidth + 5;
      });

      // Git branches
      node.gitBranches.forEach((branch) => {
        ctx.setFont("10px sans-serif");
        const metrics = ctx.measureText(branch);
        const pillWidth = metrics.width + 12;

        ctx.setFillStyle("rgba(255, 170, 0, 0.15)");
        ctx.fillRect(pillX, pillY, pillWidth, 16);
        ctx.setStrokeStyle("#ffaa00");
        ctx.setLineWidth(1);
        ctx.strokeRect(pillX, pillY, pillWidth, 16);

        ctx.setFillStyle("#ffaa00");
        ctx.fillText(branch, pillX + 6, pillY + 12);

        pillX += pillWidth + 5;
      });
    },

    renderInlineFiles(ctx: RenderContext, node: CommitNode, files: Array<{ type: string; path: string }>) {
      const textColumnX = this.config.canvasPadding + 
        (Math.max(0, ...this.nodes.map((n) => n.lane || 0)) + 1) * this.config.laneWidth + 
        this.config.textColumnGap;
      
      const startX = textColumnX + 20;
      let currentY = node.y! + 20;

      ctx.setFont("11px monospace");

      files.forEach((f) => {
        const typeColor = f.type === "A" ? "#00ff9d" : f.type === "D" ? "#ff0055" : "#00aaff";

        ctx.setFillStyle(typeColor);
        ctx.fillText(f.type, startX, currentY);

        ctx.setFillStyle("#aaa");
        ctx.fillText(f.path, startX + 20, currentY);

        currentY += 14;
      });
    },

    renderDragPreview(ctx: RenderContext, dragNode: CommitNode, dropTarget: HitRegion | null = null) {
      ctx.save();

      // Ghost at original position
      ctx.setGlobalAlpha(0.3);
      ctx.beginPath();
      ctx.arc(dragNode.x!, dragNode.y!, this.config.nodeRadius + 3, 0, Math.PI * 2);
      ctx.setFillStyle("#1a1a1a");
      ctx.fill();
      ctx.setStrokeStyle("#00f0ff");
      ctx.setLineWidth(2);
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.setFillStyle("#00f0ff");
      ctx.setFont("bold 10px monospace");
      ctx.fillText("DRAG", dragNode.x! - 15, dragNode.y! - 15);

      ctx.setGlobalAlpha(1);

      if (dropTarget?.type === "node" && dropTarget.data) {
        const target = dropTarget.data as CommitNode;

        // Animated connection line
        ctx.beginPath();
        ctx.moveTo(dragNode.x!, dragNode.y!);
        ctx.lineTo(target.x!, target.y!);
        ctx.setStrokeStyle("#00ff9d");
        ctx.setLineWidth(3);
        ctx.setLineDash([8, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Target highlight
        ctx.beginPath();
        ctx.arc(target.x!, target.y!, this.config.nodeRadius * 4, 0, Math.PI * 2);
        ctx.setStrokeStyle("#00ff9d");
        ctx.setLineWidth(4);
        ctx.stroke();

        ctx.beginPath();
        ctx.arc(target.x!, target.y!, this.config.nodeRadius * 3, 0, Math.PI * 2);
        ctx.setFillStyle("rgba(0, 255, 157, 0.2)");
        ctx.fill();

        // Label
        const label = `Move onto ${target.changeId.substring(0, 8)}`;
        ctx.setFont("bold 13px sans-serif");
        const metrics = ctx.measureText(label);
        ctx.setFillStyle("rgba(0, 0, 0, 0.8)");
        ctx.fillRect(target.x! + 20, target.y! - 25, metrics.width + 10, 22);
        ctx.setFillStyle("#00ff9d");
        ctx.fillText(label, target.x! + 25, target.y! - 10);
      } else if (dropTarget?.type === "lane") {
        const lane = dropTarget.data as number;
        const maxLane = Math.max(0, ...this.nodes.map((n) => n.lane || 0));
        const previewX = this.config.canvasPadding + ((maxLane - lane) * this.config.laneWidth);

        // Lane highlight
        ctx.beginPath();
        ctx.moveTo(previewX, -1000);
        ctx.lineTo(previewX, 10000);
        ctx.setStrokeStyle("rgba(0, 255, 157, 0.5)");
        ctx.setLineWidth(4);
        ctx.setLineDash([8, 4]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Ghost node
        ctx.beginPath();
        ctx.arc(previewX, dragNode.y!, this.config.nodeRadius * 2.5, 0, Math.PI * 2);
        ctx.setFillStyle("rgba(0, 255, 157, 0.3)");
        ctx.fill();
        ctx.setStrokeStyle("#00ff9d");
        ctx.setLineWidth(3);
        ctx.stroke();

        // Label
        const label = `Pin to Lane ${lane}`;
        ctx.setFont("bold 13px sans-serif");
        const metrics = ctx.measureText(label);
        ctx.setFillStyle("rgba(0, 0, 0, 0.8)");
        ctx.fillRect(previewX + 20, dragNode.y! - 12, metrics.width + 10, 24);
        ctx.setFillStyle("#00ff9d");
        ctx.fillText(label, previewX + 25, dragNode.y! + 5);
      }

      ctx.restore();
    },

    renderConnectionHoverIndicator(ctx: RenderContext, midX: number, midY: number) {
      ctx.save();

      // Draw plus indicator
      ctx.beginPath();
      ctx.arc(midX, midY, 6, 0, Math.PI * 2);
      ctx.setFillStyle("#00f0ff");
      ctx.fill();

      // Plus sign
      ctx.beginPath();
      ctx.moveTo(midX - 3, midY);
      ctx.lineTo(midX + 3, midY);
      ctx.moveTo(midX, midY - 3);
      ctx.lineTo(midX, midY + 3);
      ctx.setStrokeStyle("#000");
      ctx.setLineWidth(1.5);
      ctx.stroke();

      // Tooltip
      ctx.setFillStyle("#00f0ff");
      ctx.setFont("10px sans-serif");
      ctx.fillText("Click to insert", midX + 12, midY + 3);

      ctx.restore();
    },
  };
}
