export interface GraphDrawTelemetry {
  drawCount: number;
  lastDrawAtMs: number;
  width: number;
  height: number;
  totalNodes: number;
  visibleNodes: number;
  visibleRows: number;
  scrollOffset: number;
  hasSelection: boolean;
}

const graphDrawTelemetry: GraphDrawTelemetry = {
  drawCount: 0,
  lastDrawAtMs: 0,
  width: 0,
  height: 0,
  totalNodes: 0,
  visibleNodes: 0,
  visibleRows: 0,
  scrollOffset: 0,
  hasSelection: false,
};

export function reportGraphDraw(sample: Omit<GraphDrawTelemetry, "drawCount" | "lastDrawAtMs">): void {
  graphDrawTelemetry.drawCount += 1;
  graphDrawTelemetry.lastDrawAtMs = Date.now();
  graphDrawTelemetry.width = sample.width;
  graphDrawTelemetry.height = sample.height;
  graphDrawTelemetry.totalNodes = sample.totalNodes;
  graphDrawTelemetry.visibleNodes = sample.visibleNodes;
  graphDrawTelemetry.visibleRows = sample.visibleRows;
  graphDrawTelemetry.scrollOffset = sample.scrollOffset;
  graphDrawTelemetry.hasSelection = sample.hasSelection;
}

export function getGraphDrawTelemetry(): GraphDrawTelemetry {
  return {
    drawCount: graphDrawTelemetry.drawCount,
    lastDrawAtMs: graphDrawTelemetry.lastDrawAtMs,
    width: graphDrawTelemetry.width,
    height: graphDrawTelemetry.height,
    totalNodes: graphDrawTelemetry.totalNodes,
    visibleNodes: graphDrawTelemetry.visibleNodes,
    visibleRows: graphDrawTelemetry.visibleRows,
    scrollOffset: graphDrawTelemetry.scrollOffset,
    hasSelection: graphDrawTelemetry.hasSelection,
  };
}
