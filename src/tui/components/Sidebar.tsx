import { For, createMemo, Show } from "solid-js";
import { RGBA } from "@opentui/core";
import type { CommitNode, FilesCacheEntry } from "../../core/types";
import type { OpLogEntry, ObslogEntry } from "../../core/jj-api";
import type { ViewMode } from "../../core/state";
import { UI_TOKENS } from "../../core/ui-tokens";
import { getRuntimeConfig } from "../../core/runtime-config";

const PANEL_BG = RGBA.fromHex(UI_TOKENS.slate.panel);
const CYAN = RGBA.fromHex(UI_TOKENS.semantic.info);
const GREEN = RGBA.fromHex(UI_TOKENS.semantic.success);
const RED = RGBA.fromHex(UI_TOKENS.semantic.error);
const YELLOW = RGBA.fromHex(UI_TOKENS.semantic.warn);
const FG_DIM = RGBA.fromHex(UI_TOKENS.slate.textMuted);
const FG = RGBA.fromHex(UI_TOKENS.slate.text);

interface SidebarProps {
  selected: CommitNode | null;
  filesCache: Map<string, FilesCacheEntry>;
  descExpanded: boolean;
  filesExpanded: boolean;
  scrollOffset: number;
  width: number;
  height: number;
  showHelp?: boolean;
  promptMode?: boolean;
  promptLabel?: string;
  promptValue?: string;
  cursorPos?: number;
  confirmPrompt?: string | null;
  mergeMode?: boolean;
  mergeSelectedIds?: Set<string>;
  themeVersion?: number;
  themePickerMode?: boolean;
  themeOptions?: string[];
  themeSelectedIndex?: number;
  currentTheme?: string;
  viewMode?: ViewMode;
  opLogSelected?: OpLogEntry | null;
  obslogChangeId?: string | null;
  obslogSelected?: ObslogEntry | null;
}

export function Sidebar(props: SidebarProps) {
  const contentLines = createMemo(() => {
    props.themeVersion;
    const PANEL_BG = RGBA.fromHex(UI_TOKENS.slate.panel);
    const CYAN = RGBA.fromHex(UI_TOKENS.semantic.info);
    const GREEN = RGBA.fromHex(UI_TOKENS.semantic.success);
    const RED = RGBA.fromHex(UI_TOKENS.semantic.error);
    const YELLOW = RGBA.fromHex(UI_TOKENS.semantic.warn);
    const FG_DIM = RGBA.fromHex(UI_TOKENS.slate.textMuted);
    const FG = RGBA.fromHex(UI_TOKENS.slate.text);

    if (props.confirmPrompt) {
      return [
        { text: "CONFIRM ACTION", color: YELLOW },
        { text: "", color: FG_DIM },
        { text: props.confirmPrompt, color: FG },
        { text: "", color: FG_DIM },
        { text: "Press y to confirm", color: GREEN },
        { text: "Press n or Esc to cancel", color: RED },
      ];
    }

    if (props.showHelp) {
      const lines = [
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
        { text: "/           Revset filter", color: FG },
        { text: "z           Restore selected", color: FG },
        { text: "Ctrl+X a    Abandon", color: FG },
        { text: "Ctrl+X s    Squash", color: FG },
        { text: "Ctrl+X d    Duplicate", color: FG },
        { text: "Ctrl+X u    Redo", color: FG },
        { text: "Ctrl+X t    Theme picker", color: FG },
        { text: "Ctrl+X m    Merge mode", color: FG },
        { text: "Ctrl+X f    Fetch", color: FG },
        { text: "Ctrl+X p    Push", color: FG },
        { text: "Ctrl+X b    Set bookmark", color: FG },
        { text: "Ctrl+X x    Delete bookmark", color: FG },
        { text: "u           Undo", color: FG },
        { text: "y / n       Confirm / cancel", color: FG },
        { text: "", color: FG_DIM },
        { text: "View", color: CYAN },
        { text: "x           Toggle desc", color: FG },
        { text: "f           Toggle files", color: FG },
        { text: "r           Refresh", color: FG },
        { text: "h           Toggle help", color: YELLOW },
        { text: "", color: FG_DIM },
        { text: "Press h to close help", color: FG_DIM },
      ];
      return lines;
    }

    if (props.themePickerMode) {
      const lines: Array<{ text: string; color: RGBA }> = [];
      const opts = props.themeOptions || [];
      const idx = Math.max(0, Math.min(props.themeSelectedIndex || 0, Math.max(0, opts.length - 1)));
      lines.push({ text: "THEME SELECTOR", color: CYAN });
      lines.push({ text: "", color: FG_DIM });
      if (opts.length === 0) {
        lines.push({ text: "No themes found", color: FG_DIM });
      } else {
        for (let i = 0; i < opts.length; i++) {
          const theme = opts[i]!;
          const cursor = i === idx ? ">" : " ";
          const current = theme === (props.currentTheme || "") ? " *" : "";
          const color = i === idx ? GREEN : FG;
          lines.push({ text: `${cursor} ${theme}${current}`, color });
        }
      }
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "j/k or ↑/↓: select", color: FG_DIM });
      lines.push({ text: "Enter: apply", color: FG_DIM });
      lines.push({ text: "Esc: cancel", color: FG_DIM });
      return lines;
    }

    // Show op log mode content
    if (props.viewMode === "oplog" && props.opLogSelected) {
      const lines: Array<{ text: string; color: RGBA }> = [];
      const entry = props.opLogSelected;
      lines.push({ text: "OP LOG", color: YELLOW });
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: `ID: ${entry.id}`, color: CYAN });
      lines.push({ text: `Time: ${entry.time.slice(0, 19)}`, color: FG });
      lines.push({ text: `Duration: ${entry.duration}`, color: FG_DIM });
      lines.push({ text: `User: ${entry.user}`, color: FG });
      lines.push({ text: `Current: ${entry.isCurrent ? "Yes" : "No"}`, color: entry.isCurrent ? GREEN : FG_DIM });
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "Description:", color: FG_DIM });
      const descLines = (entry.descriptionFull || entry.descriptionTitle || "").split("\n");
      for (const line of descLines.slice(0, 5)) {
        lines.push({ text: line || " ", color: FG });
      }
      if (descLines.length > 5) {
        lines.push({ text: "...", color: FG_DIM });
      }
      
      // Show args tag prominently
      const argsTag = entry.tags.find((t) => t.toLowerCase().startsWith("args:"));
      if (argsTag) {
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Command:", color: FG_DIM });
        lines.push({ text: argsTag, color: YELLOW });
      }
      
      // Show other tags
      const otherTags = entry.tags.filter(t => !t.toLowerCase().startsWith("args:"));
      if (otherTags.length > 0) {
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Tags:", color: FG_DIM });
        for (const tag of otherTags) {
          lines.push({ text: `  ${tag}`, color: YELLOW });
        }
      }
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "r/Enter: restore selected op", color: FG });
      lines.push({ text: "g: back to log", color: FG });
      return lines;
    }

    // Show obslog mode content
    if (props.viewMode === "obslog" && props.obslogChangeId) {
      const lines: Array<{ text: string; color: RGBA }> = [];
      const entry = props.obslogSelected || null;
      lines.push({ text: "OBS LOG", color: YELLOW });
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: `Change: ${props.obslogChangeId.slice(0, 12)}`, color: CYAN });

      if (entry) {
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: `Commit: ${entry.commitId.slice(0, 12)}`, color: FG_DIM });
        
        // Status badges
        if (entry.isWorkingCopy) lines.push({ text: "@ working copy", color: GREEN });
        if (entry.isHidden) lines.push({ text: "hidden", color: FG_DIM });
        if (entry.isConflict) lines.push({ text: "! conflict", color: RED });
        if (entry.isEmpty) lines.push({ text: "empty", color: FG_DIM });
        
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: `Op: ${entry.operationId.slice(0, 12)}`, color: YELLOW });
        lines.push({ text: `OpUser: ${entry.operationUser}`, color: FG_DIM });
        lines.push({ text: `OpDur: ${entry.operationDuration}`, color: FG_DIM });
        const opLines = (entry.operationDescriptionFull || entry.operationDescription || "(no operation description)").split("\n");
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Operation:", color: FG_DIM });
        for (const line of opLines.slice(0, 4)) {
          lines.push({ text: line || " ", color: FG });
        }
        if (opLines.length > 4) lines.push({ text: "...", color: FG_DIM });
        
        // Show args tag prominently
        const argsTag = entry.operationTags.find((t) => t.toLowerCase().startsWith("args:"));
        if (argsTag) {
          lines.push({ text: "", color: FG_DIM });
          lines.push({ text: "Command:", color: FG_DIM });
          lines.push({ text: argsTag, color: YELLOW });
        }
        
        if (entry.operationTags.length > 0) {
          const otherTags = entry.operationTags.filter(t => !t.toLowerCase().startsWith("args:"));
          if (otherTags.length > 0) {
            lines.push({ text: "", color: FG_DIM });
            lines.push({ text: "Tags:", color: FG_DIM });
            for (const tag of otherTags.slice(0, 4)) {
              lines.push({ text: tag, color: YELLOW });
            }
            if (otherTags.length > 4) lines.push({ text: "...", color: FG_DIM });
          }
        }
        lines.push({ text: `Time: ${entry.time.slice(0, 19)}`, color: FG_DIM });
        lines.push({ text: `Author: ${entry.author}`, color: FG_DIM });
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Description:", color: FG_DIM });
        const desc = (entry.descriptionFull || entry.descriptionTitle || "(no description)").split("\n");
        for (const line of desc.slice(0, 6)) {
          lines.push({ text: line || " ", color: FG });
        }
        if (desc.length > 6) lines.push({ text: "...", color: FG_DIM });
      } else {
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Loading obslog...", color: FG_DIM });
      }

      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "j/k: move  PgUp/PgDn: jump", color: FG });
      lines.push({ text: "g: back to log", color: FG });
      return lines;
    }

    // Show merge mode content
    if (props.mergeMode && props.mergeSelectedIds) {
      const lines: Array<{ text: string; color: RGBA }> = [];
      const count = props.mergeSelectedIds.size;
      lines.push({ text: "MERGE MODE", color: YELLOW });
      lines.push({ text: `${count} commit${count === 1 ? "" : "s"} selected`, color: CYAN });
      lines.push({ text: "", color: FG_DIM });
      if (count > 0) {
        lines.push({ text: "Selected:", color: FG_DIM });
        Array.from(props.mergeSelectedIds).forEach((id) => {
          lines.push({ text: `  ${id.slice(0, 12)}`, color: GREEN });
        });
        lines.push({ text: "", color: FG_DIM });
      }
      lines.push({ text: "Space: toggle selection", color: FG });
      lines.push({ text: "Enter: create merge", color: FG });
      lines.push({ text: "Esc: cancel", color: FG });
      return lines;
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
      const maxBookmarks = 4;
      for (const b of selected.bookmarks.slice(0, maxBookmarks)) {
        lines.push({ text: `  ${b}`, color: CYAN });
      }
      if (selected.bookmarks.length > maxBookmarks) {
        lines.push({ text: `  ... +${selected.bookmarks.length - maxBookmarks} more`, color: FG_DIM });
      }
      lines.push({ text: "", color: FG_DIM });
    }

    // Show prompt if in describe mode
    if (props.promptMode) {
      const text = props.promptValue || "";
      const cursorPos = props.cursorPos ?? text.length;
      const display = text.slice(0, cursorPos) + "_" + text.slice(cursorPos);
      lines.push({ text: `${props.promptLabel || "Edit Description"}:`, color: CYAN });
      lines.push({ text: display, color: YELLOW });
      lines.push({ text: "", color: FG_DIM });
      lines.push({ text: "Enter: save  Esc: cancel  ←/→: move cursor", color: FG_DIM });
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

    lines.push({ text: props.filesExpanded ? "Files (f collapse):" : "Files (f expand):", color: FG_DIM });
    const cached = props.filesCache.get(selected.changeId);
    if (cached && cached.files.length > 0) {
      const filesToShow = props.filesExpanded ? cached.files : cached.files.slice(0, 8);
      for (const f of filesToShow) {
        const fileColor = f.type === "A" ? GREEN : f.type === "D" ? RED : CYAN;
        lines.push({ text: `${f.type} ${f.path}`, color: fileColor });
      }
      if (!props.filesExpanded && cached.files.length > filesToShow.length) {
        lines.push({ text: `... +${cached.files.length - filesToShow.length} more`, color: FG_DIM });
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

    const themeName = getRuntimeConfig().theme.name;
    const themeSelector = themeName === "ember"
      ? "Themes: slate [ember]  (Ctrl+X t)"
      : "Themes: [slate] ember  (Ctrl+X t)";
    lines.push({ text: "", color: FG_DIM });
    lines.push({ text: themeSelector, color: FG_DIM });

    return lines;
  });

  const visibleLines = createMemo(() => {
    props.themeVersion;
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
  const scrollIndicator = () => {
    const v = visibleLines();
    if (v.canScrollUp && v.canScrollDown) return "↑ PgUp/PgDn ↓";
    if (v.canScrollUp) return "↑ PgUp (more above)";
    if (v.canScrollDown) return "PgDn ↓ (more below)";
    return "";
  };

  return (
    <box
      width={props.width}
      height={props.height}
      backgroundColor={RGBA.fromHex(UI_TOKENS.slate.panel)}
    >
      <text fg={props.showHelp ? RGBA.fromHex(UI_TOKENS.semantic.warn) : RGBA.fromHex(UI_TOKENS.semantic.info)}>{title()}</text>
      <text fg={RGBA.fromHex(UI_TOKENS.slate.borderStrong)}>--------</text>
      <For each={visibleLines().lines}>
        {(line) => (
          <text fg={line.color}>
            {line.text || " "}
          </text>
        )}
      </For>
      <Show when={scrollIndicator()}>
        <box flexGrow={1} />
        <text fg={FG_DIM}>{scrollIndicator()}</text>
      </Show>
    </box>
  );
}
