import { Show, createMemo, For } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { tuiState } from "../../core/state-tui";
import { UI_TOKENS } from "../../core/ui-tokens";

const COLORS = {
  barBg: () => RGBA.fromHex(UI_TOKENS.slate.panel),
  segmentBg: () => RGBA.fromHex(UI_TOKENS.slate.bg2),
  key: () => RGBA.fromHex(UI_TOKENS.semantic.info),
  action: () => RGBA.fromHex(UI_TOKENS.slate.text),
  muted: () => RGBA.fromHex(UI_TOKENS.slate.textMuted),
  rebase: () => RGBA.fromHex(UI_TOKENS.semantic.warn),
  merge: () => RGBA.fromHex(UI_TOKENS.semantic.success),
  leader: () => RGBA.fromHex(UI_TOKENS.semantic.info),
  describe: () => RGBA.fromHex(UI_TOKENS.semantic.info),
  error: () => RGBA.fromHex(UI_TOKENS.semantic.error),
  dark: () => RGBA.fromHex(UI_TOKENS.slate.bg0),
};

interface Keybind {
  key: string;
  action: string;
}

const KEYBINDS: Record<string, Keybind[]> = {
  normal: [
    { key: "n", action: "NEW" },
    { key: "e", action: "EDIT" },
    { key: "d", action: "DESC" },
    { key: "b", action: "REBASE" },
    { key: "u", action: "UNDO" },
    { key: "^x", action: "LEADER" },
    { key: "o", action: "OPLOG" },
    { key: "v", action: "OBSLOG" },
    { key: "^d", action: "DIFF" },
    { key: "[ ]", action: "FILE DIFF" },
    { key: "/", action: "REVSET" },
    { key: "h", action: "HELP" },
  ],
  leader: [
    { key: "a", action: "ABANDON" },
    { key: "s", action: "SQUASH" },
    { key: "d", action: "DUPE" },
    { key: "u", action: "REDO" },
    { key: "t", action: "THEME" },
    { key: "r", action: "COLLAPSE" },
    { key: "m", action: "MERGE" },
    { key: "f", action: "FETCH" },
    { key: "p", action: "PUSH" },
    { key: "b", action: "BM SET" },
    { key: "x", action: "BM DEL" },
    { key: "Esc", action: "CANCEL" },
  ],
  rebase: [
    { key: "b", action: "CONFIRM" },
    { key: "Enter", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  merge: [
    { key: "Space", action: "SELECT" },
    { key: "Enter", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  describe: [
    { key: "Enter", action: "CONFIRM" },
    { key: "Esc", action: "CANCEL" },
  ],
  revset: [
    { key: "Enter", action: "APPLY" },
    { key: "Esc", action: "CANCEL" },
  ],
  oplog: [
    { key: "r", action: "RESTORE" },
    { key: "g", action: "LOG" },
    { key: "h", action: "HELP" },
  ],
  obslog: [
    { key: "g", action: "LOG" },
    { key: "h", action: "HELP" },
  ],
  diff: [
    { key: "j/k", action: "NAV" },
    { key: "[ ]", action: "FILE" },
    { key: "^d", action: "LOG" },
    { key: "g", action: "LOG" },
    { key: "h", action: "HELP" },
  ],
};

export function StatusBar(props: { width: number; height: number; themeVersion?: number }) {
  const currentMode = createMemo(() => {
    if (tuiState.revsetMode) return "revset";
    if (state.describeMode) return "describe";
    if (tuiState.leaderMode) return "leader";
    if (state.rebaseSourceId) return "rebase";
    if (tuiState.mergeMode) return "merge";
    if (state.viewMode === "oplog") return "oplog";
    if (state.viewMode === "obslog") return "obslog";
    if (state.viewMode === "diff") return "diff";
    return "normal";
  });

  const modeLabel = createMemo(() => {
    const mode = currentMode();
    switch (mode) {
      case "describe": return "DESCRIBE";
      case "revset": return "REVSET";
      case "leader": return "LEADER";
      case "rebase": return "REBASE";
      case "merge": return "MERGE";
      case "oplog": return "OPLOG";
      case "obslog": return "OBSLOG";
      case "diff": return "DIFF";
      default: return "LOG";
    }
  });

  // Theme-aware color accessors
  const themeBarBg = createMemo(() => { props.themeVersion; return COLORS.barBg(); });
  const themeDark = createMemo(() => { props.themeVersion; return COLORS.dark(); });
  const themeMuted = createMemo(() => { props.themeVersion; return COLORS.muted(); });
  const themeKey = createMemo(() => { props.themeVersion; return COLORS.key(); });
  const themeAction = createMemo(() => { props.themeVersion; return COLORS.action(); });
  const themeError = createMemo(() => { props.themeVersion; return COLORS.error(); });

  const modeColor = createMemo(() => {
    props.themeVersion; // Depend on theme version to re-render when theme changes
    const mode = currentMode();
    switch (mode) {
      case "describe": return COLORS.describe();
      case "revset": return COLORS.describe();
      case "leader": return COLORS.leader();
      case "rebase": return COLORS.rebase();
      case "merge": return COLORS.merge();
      case "oplog": return RGBA.fromHex(UI_TOKENS.semantic.info);
      case "obslog": return RGBA.fromHex(UI_TOKENS.semantic.success);
      default: return RGBA.fromHex(UI_TOKENS.semantic.modeLog);
    }
  });

  const keybinds = createMemo(() => {
    return KEYBINDS[currentMode()] || KEYBINDS.normal;
  });

  const compactActions = createMemo(() => props.width < 92);

  const actionLabel = (action: string) => {
    if (!compactActions()) return action;
    const map: Record<string, string> = {
      REBASE: "RB",
      LEADER: "LDR",
      RESTORE: "RST",
      DESCRIBE: "DESC",
      ABANDON: "ABND",
      CONFIRM: "OK",
      CANCEL: "ESC",
      SELECT: "SEL",
      APPLY: "SET",
      OBSLOG: "OBS",
      REDO: "RDO",
      THEME: "THM",
      FETCH: "FCH",
      PUSH: "PSH",
    };
    return map[action] || action;
  };

  const modeHint = createMemo(() => {
    if (props.width < 110) return "";
    switch (currentMode()) {
      case "leader":
        return "";
      case "rebase":
        return "select destination and confirm";
      case "merge":
        return "space selects commits, m confirms";
      case "describe":
        return "editing description";
      case "revset":
        return "type query, Enter applies";
      case "oplog":
        return "r restores selected operation";
      case "obslog":
        return "change observation history";
      case "diff":
        return "full diff viewer";
      default:
        return "";
    }
  });

  const showStatusMessage = createMemo(() => {
    if (!state.statusMessage) return false;
    if (/^nodes:\d+$/i.test(state.statusMessage.trim())) return false;
    if (state.statusMessage === "Loading...") return false;
    if (state.statusMessage.startsWith("Error")) return true;
    return !tuiState.leaderMode;
  });

  const wrappedKeybindRows = createMemo(() => {
    const rows: Keybind[][] = [];
    const maxRows = Math.max(1, props.height - (showStatusMessage() ? 1 : 0));
    const firstRowWidth = Math.max(20, props.width - 16);
    const otherRowWidth = Math.max(20, props.width - 2);

    const segmentWidth = (kb: Keybind) => kb.key.length + 1 + actionLabel(kb.action).length + 2;

    let current: Keybind[] = [];
    let used = 0;
    let rowIdx = 0;

    for (const kb of keybinds()) {
      const limit = rowIdx === 0 ? firstRowWidth : otherRowWidth;
      const w = segmentWidth(kb);
      if (used + w > limit && current.length > 0) {
        rows.push(current);
        if (rows.length >= maxRows) return rows;
        current = [kb];
        used = w;
        rowIdx++;
      } else {
        current.push(kb);
        used += w;
      }
    }
    if (current.length > 0 && rows.length < maxRows) rows.push(current);
    return rows;
  });

  return (
    <box height={props.height} backgroundColor={themeBarBg()} flexDirection="column">
      <For each={wrappedKeybindRows()}>
        {(row, idx) => (
          <box height={1} flexDirection="row">
            <Show when={idx() === 0}>
              <box backgroundColor={modeColor()} paddingLeft={1} paddingRight={1}>
                <text fg={themeDark()}>
                  <strong>{modeLabel()}</strong>
                </text>
              </box>
              <Show when={modeHint().length > 0}>
                <box paddingLeft={1}>
                  <text fg={themeMuted()}>{modeHint()}</text>
                </box>
              </Show>
            </Show>
            <box paddingLeft={idx() === 0 ? 2 : 1} flexDirection="row">
              <For each={row}>
                {(kb) => (
                  <box flexDirection="row">
                    <text fg={themeKey()}>{kb.key}</text>
                    <text fg={themeAction()}> {actionLabel(kb.action)}  </text>
                  </box>
                )}
              </For>
            </box>
          </box>
        )}
      </For>

      <Show when={showStatusMessage()}>
        <box height={1} paddingLeft={1}>
          <text fg={state.statusMessage?.startsWith("Error") ? themeError() : themeMuted()}>
            {state.statusMessage}
          </text>
        </box>
      </Show>
    </box>
  );
}
