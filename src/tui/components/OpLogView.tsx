import { createEffect } from "solid-js";
import { useRenderer } from "@opentui/solid";
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { OpLogEntry } from "../../core/jj-api";

const BG = RGBA.fromHex("#24283b");
const SEL_BG = RGBA.fromInts(60, 70, 100, 180);
const FG_DIM = RGBA.fromHex("#888888");
const FG = RGBA.fromHex("#bbbbbb");
const GREEN = RGBA.fromHex("#00ff9d");
const YELLOW = RGBA.fromHex("#ffaa00");
const CYAN = RGBA.fromHex("#00f0ff");
const ORANGE = RGBA.fromHex("#ff8800");

interface OpLogViewProps {
  entries: OpLogEntry[];
  selectedId: string | null;
  scrollOffset: number;
  width: number;
  height: number;
  onEnsureVisible: (visibleRows: number) => void;
}

export function OpLogView(props: OpLogViewProps) {
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
      // jj returns time as a range: "start - end", extract just the start
      const startTime = timeStr.split(" - ")[0];
      const date = new Date(startTime);
      if (isNaN(date.getTime())) {
        return startTime.slice(0, 16);
      }
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

  // Extract args from tags
  const getArgsFromTags = (tags: string[]): string | null => {
    const argsTag = tags.find((t) => t.toLowerCase().startsWith("args:"));
    return argsTag || null;
  };

  const draw = () => {
    if (!canvas) return;

    const fb = canvas.frameBuffer;
    const w = props.width;
    const h = props.height;

    if (w <= 0 || h <= 0) return;

    fb.fillRect(0, 0, w, h, BG);

    const rowStride = 5; // Increased to show args line
    const visibleRows = Math.max(1, Math.floor((h - 2) / rowStride));
    props.onEnsureVisible(visibleRows);

    const start = props.scrollOffset;
    const visible = props.entries.slice(start, start + visibleRows);

    // Find selected index in visible range
    const selLocal = visible.findIndex(e => e.id === props.selectedId);
    const selectedEntry = selLocal >= 0 ? visible[selLocal] : null;

    // Draw header
    fb.drawText("JJ Operation Log", 1, 0, CYAN);
    fb.drawText("─".repeat(Math.max(0, w - 2)), 1, 1, FG_DIM);

    const rowY = (i: number) => 2 + i * rowStride;

    // Draw entries
    for (let i = 0; i < visible.length; i++) {
      const entry = visible[i];
      const y = rowY(i);
      const isSelected = i === selLocal;
      const isCurrent = entry.isCurrent;

      // Selection background
      if (isSelected) {
        fb.fillRect(0, y, w, 4, SEL_BG);
      }

      // Current indicator
      const prefix = isCurrent ? "● " : "  ";
      const prefixColor = isCurrent ? GREEN : FG_DIM;

      // ID (first 12 chars) + user + time + duration
      const idShort = entry.id.slice(0, 12);
      fb.drawText(prefix + idShort, 1, y, isSelected ? RGBA.fromHex("#ffffff") : prefixColor);

      // User at column 16
      fb.drawText(entry.user, 16, y, FG_DIM);

      // Time at column 30
      const timeStr = formatTime(entry.time);
      fb.drawText(timeStr, 30, y, FG_DIM);

      // Duration at column 50
      fb.drawText(entry.duration, 50, y, FG_DIM);

      // Description on second line
      const descMax = Math.max(0, w - 4);
      const desc = truncate(entry.descriptionTitle, descMax);
      fb.drawText(desc, 4, y + 1, isSelected ? RGBA.fromHex("#ffffff") : FG);

      // Args line on third line if present
      const argsLine = getArgsFromTags(entry.tags);
      if (argsLine) {
        fb.drawText(truncate(argsLine, descMax), 4, y + 2, ORANGE);
      } else {
        // If no args, show second line of description if it exists
        const lines = (entry.descriptionFull || "").split("\n").map((l) => l.trim());
        const second = lines.length > 1 ? lines[1] : "";
        if (second) fb.drawText(truncate(second, descMax), 4, y + 2, FG_DIM);
      }

      // Show non-args tags on fourth line
      const otherTags = entry.tags.filter(t => !t.toLowerCase().startsWith("args:"));
      if (otherTags.length > 0) {
        const tagsStr = otherTags.slice(0, 2).join(" ");
        fb.drawText(truncate(tagsStr, descMax), 4, y + 3, YELLOW);
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
        parentBox.remove("oplog-canvas");
      } catch {
        // ignore
      }
    }

    canvas = new FrameBufferRenderable(renderer, {
      id: "oplog-canvas",
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
    props.selectedId;
    props.scrollOffset;
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
