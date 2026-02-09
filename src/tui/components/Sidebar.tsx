import { For, createMemo, Show } from "solid-js";
import { RGBA } from "@opentui/core";
import type { CommitNode, FilesCacheEntry } from "../../core/types";
import type { OpLogEntry, ObslogEntry } from "../../core/jj-api";
import type { ViewMode } from "../../core/state";
import { UI_TOKENS } from "../../core/ui-tokens";
import { getRuntimeConfig } from "../../core/runtime-config";
import { mixHex } from "../../core/color-utils";
import { commandLabel, formatKeyHint, type TuiKeymapConfig } from "../../core/tui-keymap";

const PANEL_BG = RGBA.fromHex(UI_TOKENS.slate.panel);
const CYAN = RGBA.fromHex(UI_TOKENS.semantic.info);
const GREEN = RGBA.fromHex(UI_TOKENS.semantic.success);
const RED = RGBA.fromHex(UI_TOKENS.semantic.error);
const YELLOW = RGBA.fromHex(UI_TOKENS.semantic.warn);
// Use textMuted directly instead of dimming further - much more legible
const FG_DIM = RGBA.fromHex(UI_TOKENS.slate.textMuted);
// Brighter label color for titles/headers (65% toward full text brightness)
const FG_LABEL = RGBA.fromHex(mixHex(UI_TOKENS.slate.textMuted, UI_TOKENS.slate.text, 0.65));
const FG = RGBA.fromHex(UI_TOKENS.slate.text);

// Sidebar padding (left side)
const SIDEBAR_PAD = 1;

// Truncate text to fit within maxWidth, adding ellipsis if needed
function truncateText(text: string, maxWidth: number): string {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, maxWidth);
  return text.slice(0, maxWidth - 1) + "…";
}

// Pad text with leading space and truncate to fit sidebar width
function padLine(text: string, sidebarWidth: number): string {
  const maxWidth = sidebarWidth - SIDEBAR_PAD - 1; // -1 for right margin
  const padded = " ".repeat(SIDEBAR_PAD) + text;
  return truncateText(padded, sidebarWidth - 1);
}

// Map file extensions to tree-sitter language identifiers
function getLanguageFromPath(path: string): string | undefined {
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    py: 'python', rs: 'rust', go: 'go',
    json: 'json', toml: 'toml', yaml: 'yaml', yml: 'yaml',
    md: 'markdown', html: 'html', css: 'css', scss: 'css',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
    java: 'java', rb: 'ruby', lua: 'lua', sql: 'sql',
  };
  return ext ? langMap[ext] : undefined;
}

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
  diffPreview?: {
    path: string;
    diff: string;
    index: number;
    total: number;
  } | null;
  collapsed?: boolean;
  keymap?: TuiKeymapConfig;
}

export function Sidebar(props: SidebarProps) {
  const isCollapsed = createMemo(() => Boolean(props.collapsed));

  const panelBg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.panel);
  });
  const titleFg = createMemo(() => {
    props.themeVersion;
    return props.showHelp ? RGBA.fromHex(UI_TOKENS.semantic.warn) : RGBA.fromHex(UI_TOKENS.semantic.info);
  });
  const borderFg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.borderStrong);
  });
  const scrollFg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.textMuted);
  });
  const diffHeaderFg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.semantic.success);
  });
  const diffColors = createMemo(() => {
    props.themeVersion;
    const diffTheme = ((UI_TOKENS as unknown as { diff?: Record<string, string> }).diff) || {};
    return {
      lineNumberFg: UI_TOKENS.slate.textMuted,
      lineNumberBg: UI_TOKENS.slate.bg1,
      contextBg: diffTheme.contextBg || UI_TOKENS.slate.panel,
      contextContentBg: diffTheme.contextContentBg || UI_TOKENS.slate.panel,
      addedBg: diffTheme.addedBg || mixHex(UI_TOKENS.slate.panel, UI_TOKENS.semantic.fileAdd, 0.48),
      removedBg: diffTheme.removedBg || mixHex(UI_TOKENS.slate.panel, UI_TOKENS.semantic.fileDel, 0.48),
      addedContentBg: diffTheme.addedContentBg || mixHex(UI_TOKENS.slate.panel, UI_TOKENS.semantic.fileAdd, 0.48),
      removedContentBg: diffTheme.removedContentBg || mixHex(UI_TOKENS.slate.panel, UI_TOKENS.semantic.fileDel, 0.48),
      addedSignColor: diffTheme.addedSignColor || UI_TOKENS.semantic.fileAdd,
      removedSignColor: diffTheme.removedSignColor || UI_TOKENS.semantic.fileDel,
      addedLineNumberBg: UI_TOKENS.slate.bg1,
      removedLineNumberBg: UI_TOKENS.slate.bg1,
      fg: UI_TOKENS.slate.text,
    };
  });

  const showInlineDiff = createMemo(() => {
    if (isCollapsed()) return false;
    if (!props.diffPreview) return false;
    if (props.viewMode && props.viewMode !== "log") return false;
    if (props.confirmPrompt) return false;
    if (props.showHelp) return false;
    if (props.themePickerMode) return false;
    if (props.promptMode) return false;
    if (props.mergeMode) return false;
    return true;
  });

  const diffBodyHeight = createMemo(() => {
    if (!showInlineDiff()) return 0;
    return Math.max(6, Math.floor(props.height * 0.35));
  });

  // Derive syntax highlighting language from diff file path
  const diffLanguage = createMemo(() => {
    if (!props.diffPreview?.path) return undefined;
    return getLanguageFromPath(props.diffPreview.path);
  });

  const detailRows = createMemo(() => {
    const reserved = 2 + 1 + (showInlineDiff() ? 2 + diffBodyHeight() : 0);
    return Math.max(1, props.height - reserved);
  });

  const contentLines = createMemo(() => {
    props.themeVersion;
    const PANEL_BG = RGBA.fromHex(UI_TOKENS.slate.panel);
    const CYAN = RGBA.fromHex(UI_TOKENS.semantic.info);
    const GREEN = RGBA.fromHex(UI_TOKENS.semantic.success);
    const RED = RGBA.fromHex(UI_TOKENS.semantic.error);
    const YELLOW = RGBA.fromHex(UI_TOKENS.semantic.warn);
    // Use textMuted directly instead of dimming further - much more legible
    const FG_DIM = RGBA.fromHex(UI_TOKENS.slate.textMuted);
    // Brighter label color for titles/headers (65% toward full text brightness)
    const FG_LABEL = RGBA.fromHex(mixHex(UI_TOKENS.slate.textMuted, UI_TOKENS.slate.text, 0.65));
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
        { text: "Leader Modes", color: CYAN },
        { text: "y / n       Confirm / cancel", color: FG },
        { text: "", color: FG_DIM },
        { text: "View", color: CYAN },
        { text: "[ / ]       Cycle file diff", color: FG },
        { text: "q           Quit", color: FG },
        { text: "Esc/q       Exit active mode", color: FG },
        { text: "h           Toggle help", color: YELLOW },
        { text: "", color: FG_DIM },
        { text: "Press h to close help", color: FG_DIM },
      ];

      if (props.keymap) {
        const modeLines: Array<{ text: string; color: RGBA }> = [];
        for (const mode of props.keymap.modeOrder) {
          modeLines.push({ text: `${props.keymap.leaders[mode]}  ${props.keymap.labels[mode]}`, color: FG });
          const bindings = Object.entries(props.keymap.modeBindings[mode]).sort((a, b) => a[0].localeCompare(b[0]));
          if (bindings.length > 0) {
            const summary = bindings
              .slice(0, 6)
              .map(([key, command]) => `${key}:${commandLabel(command)}`)
              .join("  ");
            modeLines.push({ text: `  ${summary}`, color: FG_DIM });
          }
        }

        if (Object.keys(props.keymap.idleBindings).length > 0) {
          modeLines.push({ text: "", color: FG_DIM });
          modeLines.push({ text: "Idle Bindings", color: CYAN });
          const idleSummary = Object.entries(props.keymap.idleBindings)
            .sort((a, b) => a[0].localeCompare(b[0]))
            .map(([key, command]) => `${key}:${commandLabel(command)}`)
            .join("  ");
          modeLines.push({ text: idleSummary, color: FG_DIM });
        }

        const insertAt = lines.findIndex((line) => line.text === "y / n       Confirm / cancel");
        lines.splice(Math.max(0, insertAt), 0, ...modeLines, { text: "", color: FG_DIM });
      }

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
      lines.push({ text: "Description:", color: FG_LABEL });
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
        lines.push({ text: "Command:", color: FG_LABEL });
        lines.push({ text: argsTag, color: YELLOW });
      }
      
      // Show other tags
      const otherTags = entry.tags.filter(t => !t.toLowerCase().startsWith("args:"));
      if (otherTags.length > 0) {
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Tags:", color: FG_LABEL });
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
        lines.push({ text: `Commit: ${entry.commitId.slice(0, 12)}`, color: FG_LABEL });
        
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
        lines.push({ text: "Operation:", color: FG_LABEL });
        for (const line of opLines.slice(0, 4)) {
          lines.push({ text: line || " ", color: FG });
        }
        if (opLines.length > 4) lines.push({ text: "...", color: FG_DIM });
        
        // Show args tag prominently
        const argsTag = entry.operationTags.find((t) => t.toLowerCase().startsWith("args:"));
        if (argsTag) {
          lines.push({ text: "", color: FG_DIM });
          lines.push({ text: "Command:", color: FG_LABEL });
          lines.push({ text: argsTag, color: YELLOW });
        }
        
        if (entry.operationTags.length > 0) {
          const otherTags = entry.operationTags.filter(t => !t.toLowerCase().startsWith("args:"));
          if (otherTags.length > 0) {
            lines.push({ text: "", color: FG_DIM });
            lines.push({ text: "Tags:", color: FG_LABEL });
            for (const tag of otherTags.slice(0, 4)) {
              lines.push({ text: tag, color: YELLOW });
            }
            if (otherTags.length > 4) lines.push({ text: "...", color: FG_DIM });
          }
        }
        lines.push({ text: `Time: ${entry.time.slice(0, 19)}`, color: FG_LABEL });
        lines.push({ text: `Author: ${entry.author}`, color: FG_LABEL });
        lines.push({ text: "", color: FG_DIM });
        lines.push({ text: "Description:", color: FG_LABEL });
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
    lines.push({ text: `Commit: ${selected.commitId}`, color: FG_LABEL });
    lines.push({ text: `Author: ${selected.author}`, color: FG_LABEL });
    lines.push({ text: `Time: ${selected.time}`, color: FG_LABEL });
    lines.push({ text: "", color: FG_DIM });

    if (selected.bookmarks.length > 0) {
      lines.push({ text: "Bookmarks:", color: FG_LABEL });
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

    lines.push({ text: props.descExpanded ? "Description:" : "Description (x expand):", color: FG_LABEL });
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

    lines.push({ text: props.filesExpanded ? "Files (f collapse):" : "Files (f expand):", color: FG_LABEL });
    const cached = props.filesCache.get(selected.changeId);
    if (cached && cached.files.length > 0) {
      const filesToShow = props.filesExpanded ? cached.files : cached.files.slice(0, 8);
      const maxFileWidth = props.width - 4; // Leave room for type prefix and margins
      for (const f of filesToShow) {
        const fileColor = f.type === "A" ? GREEN : f.type === "D" ? RED : CYAN;
        const fileText = `${f.type} ${truncateText(f.path, maxFileWidth - 2)}`;
        lines.push({ text: fileText, color: fileColor });
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
    const idleThemeKey = props.keymap
      ? Object.entries(props.keymap.idleBindings).find(([, cmd]) => cmd === "theme-picker")?.[0]
      : null;
    const viewLeader = props.keymap?.leaders.view || "ctrl+l";
    const viewBindings = props.keymap?.modeBindings.view || {};
    const viewThemeKey = Object.entries(viewBindings).find(([, cmd]) => cmd === "theme-picker")?.[0] || "t";
    const themeHint = idleThemeKey
      ? formatKeyHint(idleThemeKey)
      : `${formatKeyHint(viewLeader)} then ${formatKeyHint(viewThemeKey)}`;
    const themeSelector = themeName === "ember"
      ? `Themes: slate [ember]  (${themeHint})`
      : `Themes: [slate] ember  (${themeHint})`;
    lines.push({ text: "", color: FG_DIM });
    lines.push({ text: themeSelector, color: FG_DIM });

    return lines;
  });

  const visibleLines = createMemo(() => {
    props.themeVersion;
    const all = contentLines();
    const maxScroll = Math.max(0, all.length - detailRows());
    const offset = Math.max(0, Math.min(props.scrollOffset, maxScroll));
    return {
      lines: all.slice(offset, offset + detailRows()),
      canScrollUp: offset > 0,
      canScrollDown: offset < maxScroll,
    };
  });

  const title = () => (props.showHelp ? "Help (h to close)" : isCollapsed() ? "Sidebar" : "Details");
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
      backgroundColor={panelBg()}
      paddingLeft={1}
    >
      <Show
        when={isCollapsed()}
        fallback={
          <>
            <text fg={titleFg()}>{title()}</text>
            <text fg={borderFg()}>{"-".repeat(Math.max(0, props.width - 1))}</text>
            <For each={visibleLines().lines}>
              {(line) => (
                <text fg={line.color}>
                  {line.text || " "}
                </text>
              )}
            </For>
            <text fg={scrollFg()}>{scrollIndicator() || " "}</text>

            <Show when={showInlineDiff()}>
              <text fg={diffHeaderFg()}>{truncateText(`Diff ${props.diffPreview!.index + 1}/${props.diffPreview!.total}: ${props.diffPreview!.path}`, props.width - 2)}</text>
              <text fg={scrollFg()}>{truncateText("[ / ] switch file, Ctrl+d full diff", props.width - 2)}</text>
              <box height={diffBodyHeight()}>
                <diff
                  width={Math.max(1, props.width - 4)}
                  height={diffBodyHeight()}
                  diff={props.diffPreview!.diff}
                  filetype={diffLanguage()}
                  view="unified"
                  showLineNumbers={true}
                  lineNumberFg={diffColors().lineNumberFg}
                  lineNumberBg={diffColors().lineNumberBg}
                  contextBg={diffColors().contextBg}
                  addedBg={diffColors().addedBg}
                  removedBg={diffColors().removedBg}
                  addedContentBg={diffColors().addedContentBg}
                  removedContentBg={diffColors().removedContentBg}
                  contextContentBg={diffColors().contextContentBg}
                  addedSignColor={diffColors().addedSignColor}
                  removedSignColor={diffColors().removedSignColor}
                  addedLineNumberBg={diffColors().addedLineNumberBg}
                  removedLineNumberBg={diffColors().removedLineNumberBg}
                  fg={diffColors().fg}
                  wrapMode="char"
                />
              </box>
            </Show>
          </>
        }
      >
        <text fg={titleFg()}>[ ]</text>
        <text fg={FG_DIM}>^X r</text>
      </Show>
    </box>
  );
}
