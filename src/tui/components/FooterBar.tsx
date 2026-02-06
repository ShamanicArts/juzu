import { createMemo, Show } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { UI_TOKENS } from "../../core/ui-tokens";

export function FooterBar(props: { themeVersion?: number }) {
  // Theme-aware color accessors
  const barBg = createMemo(() => { props.themeVersion; return RGBA.fromHex(UI_TOKENS.slate.panel); });
  const segmentBg = createMemo(() => { props.themeVersion; return RGBA.fromHex(UI_TOKENS.slate.bg2); });
  const muted = createMemo(() => { props.themeVersion; return UI_TOKENS.slate.textMuted; });
  const wc = createMemo(() => { props.themeVersion; return UI_TOKENS.semantic.success; });
  const bookmark = createMemo(() => { props.themeVersion; return UI_TOKENS.semantic.info; });

  // Get working copy info
  const workingCopy = createMemo(() => {
    const nodes = state.nodes || [];
    const wc = nodes.find(n => n.isWorkingCopy);
    return wc;
  });

  const wcChangeId = createMemo(() => {
    const wc = workingCopy();
    if (!wc) return "";
    return `@${wc.changeId?.slice(0, 8) || ""}`;
  });

  const currentBookmark = createMemo(() => {
    const wc = workingCopy();
    if (!wc?.bookmarks?.length) return "";
    const first = wc.bookmarks[0];
    const more = wc.bookmarks.length > 1 ? `+${wc.bookmarks.length - 1}` : "";
    return `${first}${more}`;
  });

  const nodeCount = createMemo(() => {
    return state.nodes?.length || 0;
  });

  const layoutMode = createMemo(() => {
    return state.layoutMode || "chronological";
  });

  const repoPath = createMemo(() => {
    const cwd = state.cwd || process.cwd();
    const home = process.env.HOME || "";
    if (home && cwd.startsWith(home)) {
      return "~" + cwd.slice(home.length);
    }
    return cwd;
  });

  return (
    <box height={1} backgroundColor={barBg()} flexDirection="row">
      {/* Repo path */}
      <box backgroundColor={segmentBg()} paddingLeft={1} paddingRight={1}>
        <text fg={muted()}>{repoPath()}</text>
      </box>

      {/* Current bookmark if any */}
      <Show when={currentBookmark()}>
        <box paddingLeft={1} paddingRight={1}>
          <text fg={bookmark()}>{currentBookmark()}</text>
        </box>
      </Show>

      {/* Working copy change ID */}
      <Show when={wcChangeId()}>
        <box paddingLeft={1}>
          <text fg={wc()}>{wcChangeId()}</text>
        </box>
      </Show>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Layout mode */}
      <box paddingRight={1}>
        <text fg={muted()}>{layoutMode()}</text>
      </box>

      {/* Node count */}
      <box backgroundColor={segmentBg()} paddingLeft={1} paddingRight={1}>
        <text fg={muted()}>{nodeCount()} nodes</text>
      </box>
    </box>
  );
}
