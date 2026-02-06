import { createEffect } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { ObslogEntry } from "../../core/jj-api";
import { UI_TOKENS } from "../../core/ui-tokens";

const SEL_BG = RGBA.fromInts(60, 70, 100, 180);

interface ObslogViewProps {
  entries: ObslogEntry[];
  scrollOffset: number;
  selectedIndex: number;
  width: number;
  height: number;
  onEnsureVisible: (visibleRows: number) => void;
  changeId: string | null;
  themeVersion?: number;
}

export function ObslogView(props: ObslogViewProps) {
  const renderer = useRenderer();
  let canvas: FrameBufferRenderable | undefined;
  let parentBox: any = undefined;

  const truncate = (s: string, maxLen: number) => {
    if (maxLen <= 0) return "";
    if (s.length <= maxLen) return s;
    return s.length > maxLen - 3 ? s.slice(0, maxLen - 3) + "..." : s;
  };

  const formatTime = (timeStr: string) => {
    try {
      const date = new Date(timeStr);
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return timeStr.slice(0, 16);
    }
  };

  // Extract args from operation tags
  const getArgsFromTags = (tags: string[]): string | null => {
    const argsTag = tags.find((t) => t.toLowerCase().startsWith("args:"));
    return argsTag || null;
  };

  const draw = () => {
    if (!canvas) return;

    const BG = RGBA.fromHex(UI_TOKENS.slate.bg0);
    const FG_DIM = RGBA.fromHex(UI_TOKENS.slate.textMuted);
    const FG = RGBA.fromHex(UI_TOKENS.slate.text);
    const GREEN = RGBA.fromHex(UI_TOKENS.semantic.success);
    const RED = RGBA.fromHex(UI_TOKENS.semantic.error);
    const CYAN = RGBA.fromHex(UI_TOKENS.semantic.info);
    const YELLOW = RGBA.fromHex(UI_TOKENS.semantic.warn);
    const ORANGE = RGBA.fromHex(UI_TOKENS.graph.lanes[3] || UI_TOKENS.semantic.warn);

    const fb = canvas.frameBuffer;
    const w = props.width;
    const h = props.height;

    if (w <= 0 || h <= 0) return;

    fb.fillRect(0, 0, w, h, BG);

    const rowStride = 5; // Increased to show operation info
    const visibleRows = Math.max(1, Math.floor((h - 2) / rowStride));
    props.onEnsureVisible(visibleRows);

    const selectedIdx = Math.max(0, Math.min(props.selectedIndex, Math.max(0, props.entries.length - 1)));
    const maxStart = Math.max(0, props.entries.length - visibleRows);
    const start = Math.max(0, Math.min(props.scrollOffset, maxStart));
    const visible = props.entries.slice(start, start + visibleRows);

    // Draw header
    const changeIdShort = props.changeId ? props.changeId.slice(0, 8) : "unknown";
    fb.drawText(`Observation Log for ${changeIdShort}`, 1, 0, CYAN);
    fb.drawText("─".repeat(Math.max(0, w - 2)), 1, 1, FG_DIM);

    if (props.entries.length === 0) {
      fb.drawText("Loading obslog...", 1, 3, FG_DIM);
      canvas.requestRender?.();
      return;
    }

    const rowY = (i: number) => 2 + i * rowStride;

    // Draw entries
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i];
      const y = rowY(i);
      const isSelected = start + i === selectedIdx;

      // Selection background for current version
      if (isSelected) {
        fb.fillRect(0, y, w, 4, SEL_BG);
      }

      // Working copy indicator
      let prefix = "  ";
      let prefixColor = FG_DIM;
      if (entry.isWorkingCopy) {
        prefix = "@ ";
        prefixColor = GREEN;
      } else if (isSelected) {
        prefix = "● ";
        prefixColor = CYAN;
      }

      // Change ID and Commit ID
      const changeShort = entry.changeId.slice(0, 8);
      const commitShort = entry.commitId.slice(0, 12);

      fb.drawText(prefix + changeShort, 1, y, isSelected ? RGBA.fromHex("#ffffff") : prefixColor);
      fb.drawText(commitShort, 14, y, FG_DIM);

      // Time
      const timeStr = formatTime(entry.time);
      fb.drawText(timeStr, 28, y, FG_DIM);

      // Status indicators
      let xOffset = 46;
      if (entry.isHidden) {
        fb.drawText("hidden", xOffset, y, FG_DIM);
        xOffset += 8;
      }
      if (entry.isConflict) {
        fb.drawText("[CONFLICT]", xOffset, y, RED);
        xOffset += 12;
      } else if (entry.isEmpty) {
        fb.drawText("[empty]", xOffset, y, FG_DIM);
        xOffset += 9;
      }

      // Bookmarks
      if (entry.bookmarks.length > 0) {
        const bm = `(${entry.bookmarks.join(", ")})`;
        fb.drawText(bm, xOffset, y, YELLOW);
      }

      // Author
      fb.drawText(entry.author, 4, y + 1, FG_DIM);

      // Description
      const descMax = Math.max(0, w - 4);
      const desc = truncate(entry.descriptionTitle || "(no description)", descMax);
      fb.drawText(desc, 4, y + 2, isSelected ? RGBA.fromHex("#ffffff") : FG);

      // Operation info on line 3
      const opShort = entry.operationId ? entry.operationId.slice(0, 12) : "";
      const opLine = entry.operationDescription || "";
      const opText = opShort ? `op ${opShort}  ${opLine}` : opLine;
      fb.drawText(truncate(opText, Math.max(0, w - 6)), 4, y + 3, CYAN);

      // Args on line 4 if present
      const argsLine = getArgsFromTags(entry.operationTags);
      if (argsLine) {
        fb.drawText(truncate(argsLine, Math.max(0, w - 6)), 4, y + 4, ORANGE);
      }
    }

    // Draw scrollbar indicator
    if (props.entries.length > visibleRows) {
      const scrollPercent = props.scrollOffset / Math.max(1, props.entries.length - visibleRows);
      const barHeight = Math.max(1, Math.floor((visibleRows / props.entries.length) * (h - 3)));
      const barY = 2 + Math.floor(scrollPercent * (h - 3 - barHeight));
      fb.fillRect(w - 1, barY, 1, barHeight, FG_DIM);
    }

    canvas.requestRender?.();
  };

  const setupCanvas = (el: any) => {
    if (!el) return;
    parentBox = el;

    if (canvas) {
      try {
        parentBox.remove("obslog-canvas");
      } catch {
        // ignore
      }
    }

    canvas = new FrameBufferRenderable(renderer, {
      id: "obslog-canvas",
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
    props.entries;
    props.scrollOffset;
    props.selectedIndex;
    props.width;
    props.height;
    props.themeVersion;
    props.changeId;

    if (canvas && parentBox) {
      const nextW = props.width;
      const nextH = props.height;
      const currentW = (canvas as any).width as number;
      const currentH = (canvas as any).height as number;
      if (currentW !== nextW) (canvas as any).width = nextW;
      if (currentH !== nextH) (canvas as any).height = nextH;
      draw();
    }
  });

  return <box ref={setupCanvas} width={props.width} height={props.height} backgroundColor={RGBA.fromHex(UI_TOKENS.slate.bg0)} />;
}
