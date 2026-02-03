import { For, createMemo, Show } from "solid-js";
import { RGBA } from "@opentui/core";
import type { CommitNode, FilesCacheEntry } from "../types";

const PANEL_BG = RGBA.fromHex("#1a1b26");
const CYAN = RGBA.fromHex("#00f0ff");
const GREEN = RGBA.fromHex("#00ff9d");
const RED = RGBA.fromHex("#ff0055");
const YELLOW = RGBA.fromHex("#ffaa00");
const FG_DIM = RGBA.fromHex("#888888");
const FG = RGBA.fromHex("#bbbbbb");

interface SidebarProps {
  selected: CommitNode | undefined;
  filesCache: Map<string, FilesCacheEntry>;
  descExpanded: boolean;
  filesExpanded: boolean;
  scrollOffset: number;
  width: number;
  height: number;
  showHelp?: boolean;
  promptMode?: boolean;
  promptValue?: string;
}

export function Sidebar(props: SidebarProps) {
  const contentLines = createMemo(() => {
    // Show help content
    if (props.showHelp) {
      return [
        { text: "Navigation", color: CYAN },
        { text: "j/k or ↑/↓  Navigate", color: FG },
        { text: "PgUp/PgDn   Scroll", color: FG },
        { text: "", color: FG_DIM },
        { text: "Layout", color: CYAN },
        { text: "1-5         Layout modes", color: FG },
        { text: "", color: FG_DIM },
        { text: "Operations", color: CYAN },
        { text: "n           New commit", color: FG },
        { text: "e           Edit/checkout", color: FG },
        { text: "d           Describe", color: FG },
        { text: "b           Rebase", color: FG },
        { text: "Ctrl+x a    Abandon", color: FG },
        { text: "Ctrl+x s    Squash", color: FG },
        { text: "Ctrl+x d    Duplicate", color: FG },
        { text: "u           Undo", color: FG },
        { text: "", color: FG_DIM },
        { text: "View", color: CYAN },
        { text: "x           Toggle desc", color: FG },
        { text: "f           Toggle files", color: FG },
        { text: "r           Refresh", color: FG },
        { text: "h           Toggle help", color: YELLOW },
        { text: "", color: FG_DIM },
        { text: "Press h to close help", color: FG_DIM },
      ];
    }

    const lines: Array<{ text: string; color: RGBA }> = [];
    const selected = props.selected;

    if (!selected) {
      lines.push({ text: "No commit selected", color: FG_DIM });
      return lines;
    }

    lines.push({ text: `Change: ${selected.changeId}${selected.isWorkingCopy ? " (@)" : ""}`, color: selected.isWorkingCopy ? GREEN : CYAN });
    lines.push({ text: `Commit: ${selected.commitId}`, color: FG_DIM });
    lines.push({ text: `Author: ${selected.author}`, color: FG_DIM });
    lines.push({ text: `Time: ${selected.time}`, color: FG_DIM });
    lines.push({ text: "", color: FG_DIM });

    if (selected.bookmarks.length > 0) {
      lines.push({ text: "Bookmarks:", color: FG_DIM });
      for (const b of selected.bookmarks) {
        lines.push({ text: `  ${b}`, color: CYAN });
      }
      lines.push({ text: "", color: FG_DIM });
    }

    // Show prompt if in describe mode
    if (props.promptMode) {
      lines.push({ text: "Edit Description:", color: CYAN });
      lines.push({ text: props.promptValue || "(empty)", color: YELLOW });
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "Enter: save  Esc: cancel", color: FG_DIM });
      lines.push({ text: "", color: FG_DIM });
    }

    lines.push({ text: props.descExpanded ? "Description:" : "Description (x expand):", color: FG_DIM });
    const descText = selected.descriptionFull || selected.descriptionTitle || "(no description)";
    const maxDescLines = props.descExpanded ? 1000 : 2;
    let descLinesShown = 0;
    for (const rawLine of descText.split("\n")) {
      const line = rawLine || "";
      if (descLinesShown >= maxDescLines) break;
      if (line.length <= props.width - 4) {
        lines.push({ text: line, color: FG });
        descLinesShown++;
      } else {
        for (let i = 0; i < line.length && descLinesShown < maxDescLines; i += props.width - 4) {
          lines.push({ text: line.slice(i, i + props.width - 4), color: FG });
          descLinesShown++;
        }
      }
    }
    if (!props.descExpanded && descText.split("\n").length > 2) {
      lines.push({ text: "...", color: FG_DIM });
    }
    lines.push({ text: "", color: FG_DIM });

    lines.push({ text: props.filesExpanded ? "Files:" : "Files (f expand):", color: FG_DIM });
    const cached = props.filesCache.get(selected.changeId);
    if (cached && cached.files.length > 0) {
      for (const f of cached.files) {
        const fileColor = f.type === "A" ? GREEN : f.type === "D" ? RED : CYAN;
        lines.push({ text: `${f.type} ${f.path}`, color: fileColor });
      }
    } else if (cached) {
      lines.push({ text: "(no changes)", color: FG_DIM });
    } else {
      lines.push({ text: "(loading...)", color: FG_DIM });
    }

    if (selected.isConflict) {
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "! CONFLICTS", color: RED });
    }

    return lines;
  });

  const visibleLines = createMemo(() => {
    const all = contentLines();
    const maxScroll = Math.max(0, all.length - props.height + 3);
    const offset = Math.max(0, Math.min(props.scrollOffset, maxScroll));
    return {
      lines: all.slice(offset, offset + props.height - 2),
      canScrollUp: offset > 0,
      canScrollDown: offset < maxScroll,
    };
  });

  const title = () => props.showHelp ? "Help (h to close)" : "Details";

  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={PANEL_BG}
    >
      <text fg={props.showHelp ? YELLOW : CYAN}>{title()}</text>
      <text fg={RGBA.fromHex("#444444")}>--------</text>
      <For each={visibleLines().lines}>
        {(line) => (
          <text fg={line.color}>
            {line.text || " "}
          </text>
        )}
      </For>
    </box>
  );
}
