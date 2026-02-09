import { For, Show, createMemo } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { tuiState } from "../../core/state-tui";
import { UI_TOKENS } from "../../core/ui-tokens";
import { commandLabel, type TuiKeymapConfig } from "../../core/tui-keymap";

type Hint = { key: string; label: string };

const COLORS = {
  barBg: () => RGBA.fromHex(UI_TOKENS.slate.panel),
  modeBg: () => RGBA.fromHex(UI_TOKENS.slate.bg2),
  modeText: () => RGBA.fromHex(UI_TOKENS.slate.text),
  badgeMutedBg: () => RGBA.fromHex(UI_TOKENS.slate.bg2),
  badgeMutedText: () => RGBA.fromHex(UI_TOKENS.slate.textMuted),
  badgeActiveBg: () => RGBA.fromHex(UI_TOKENS.semantic.info),
  badgeActiveText: () => RGBA.fromHex(UI_TOKENS.slate.bg0),
  key: () => RGBA.fromHex(UI_TOKENS.semantic.info),
  action: () => RGBA.fromHex(UI_TOKENS.slate.text),
  muted: () => RGBA.fromHex(UI_TOKENS.slate.textMuted),
  error: () => RGBA.fromHex(UI_TOKENS.semantic.error),
};

export function StatusBar(props: { width: number; height: number; themeVersion?: number; keymap: TuiKeymapConfig }) {
  const currentMode = createMemo(() => {
    if (tuiState.revsetMode) return "REVSET";
    if (state.describeMode) return "DESCRIBE";
    if (state.rebaseSourceId) return "REBASE";
    if (tuiState.mergeMode) return "MERGE";
    if (tuiState.themePickerMode) return "THEME";
    if (state.viewMode === "oplog") return "OPLOG";
    if (state.viewMode === "obslog") return "OBSLOG";
    if (state.viewMode === "diff") return "DIFF";
    if (tuiState.activeLeaderMode) return props.keymap.labels[tuiState.activeLeaderMode].toUpperCase();
    return "LOG";
  });

  const showStatusMessage = createMemo(() => {
    const msg = (state.statusMessage || "").trim();
    if (!msg) return false;
    if (/^nodes:\d+$/i.test(msg)) return false;
    if (msg === "Loading...") return false;
    if (msg.startsWith("Error")) return true;
    return !tuiState.activeLeaderMode;
  });

  const badgeRows = createMemo(() => {
    return props.keymap.modeOrder.map((mode) => ({
      id: mode,
      active: tuiState.activeLeaderMode === mode,
      badge: props.keymap.badges[mode],
      trigger: props.keymap.leaders[mode],
    }));
  });

  const hintItems = createMemo<Hint[]>(() => {
    if (tuiState.activeLeaderMode) {
      return Object.entries(props.keymap.modeBindings[tuiState.activeLeaderMode])
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([key, command]) => ({ key, label: commandLabel(command) }));
    }

    const leaders: Hint[] = props.keymap.modeOrder.map((mode) => ({
      key: props.keymap.leaders[mode],
      label: props.keymap.labels[mode],
    }));

    if (!props.keymap.showIdleBindingsInStatus) return leaders;
    const idle = Object.entries(props.keymap.idleBindings)
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, command]) => ({ key, label: commandLabel(command) }));
    return [...leaders, ...idle];
  });

  const wrappedHintRows = createMemo(() => {
    const rows: Hint[][] = [];
    const maxRows = Math.max(1, props.height - 1 - (showStatusMessage() ? 1 : 0));
    const maxWidth = Math.max(16, props.width - 2);
    const segmentWidth = (item: Hint) => item.key.length + item.label.length + 4;

    let current: Hint[] = [];
    let used = 0;

    for (const item of hintItems()) {
      const w = segmentWidth(item);
      if (used + w > maxWidth && current.length > 0) {
        rows.push(current);
        if (rows.length >= maxRows) return rows;
        current = [item];
        used = w;
      } else {
        current.push(item);
        used += w;
      }
    }

    if (current.length > 0 && rows.length < maxRows) rows.push(current);
    return rows;
  });

  const themeBarBg = createMemo(() => {
    props.themeVersion;
    return COLORS.barBg();
  });

  return (
    <box height={props.height} backgroundColor={themeBarBg()} flexDirection="column">
      <box height={1} flexDirection="row" alignItems="center">
        <box backgroundColor={COLORS.modeBg()} paddingLeft={1} paddingRight={1}>
          <text fg={COLORS.modeText()}>
            <strong>{currentMode()}</strong>
          </text>
        </box>

        <box paddingLeft={1} flexDirection="row">
          <For each={badgeRows()}>
            {(badge) => (
              <>
                <box backgroundColor={badge.active ? COLORS.badgeActiveBg() : COLORS.badgeMutedBg()} paddingLeft={1} paddingRight={1}>
                  <text fg={badge.active ? COLORS.badgeActiveText() : COLORS.badgeMutedText()}>
                    {badge.badge}
                  </text>
                  <Show when={!badge.active}>
                    <text fg={COLORS.badgeMutedText()}>:{badge.trigger}</text>
                  </Show>
                </box>
                <text> </text>
              </>
            )}
          </For>
        </box>

        <box flexGrow={1} />
        <Show when={tuiState.activeLeaderMode}>
          <box paddingRight={1}>
            <text fg={COLORS.muted()}>Esc/Ctrl+g exit mode</text>
          </box>
        </Show>
      </box>

      <For each={wrappedHintRows()}>
        {(row) => (
          <box height={1} paddingLeft={1} flexDirection="row">
            <For each={row}>
              {(item) => (
                <box flexDirection="row">
                  <text fg={COLORS.key()}>{item.key}</text>
                  <text fg={COLORS.action()}> {item.label} </text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>

      <Show when={showStatusMessage()}>
        <box height={1} paddingLeft={1}>
          <text fg={state.statusMessage?.startsWith("Error") ? COLORS.error() : COLORS.muted()}>{state.statusMessage}</text>
        </box>
      </Show>
    </box>
  );
}
