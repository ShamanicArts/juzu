import { createMemo, Show } from "solid-js";
import { RGBA } from "@opentui/core";
import { state } from "../../core/state";
import { UI_TOKENS } from "../../core/ui-tokens";

const COLORS = {
  barBg: RGBA.fromHex(UI_TOKENS.slate.panel),
  segmentBg: RGBA.fromHex(UI_TOKENS.slate.bg2),
  muted: UI_TOKENS.slate.textMuted,
  wc: UI_TOKENS.semantic.success,
  bookmark: UI_TOKENS.semantic.info,
};

export function FooterBar() {
  // Get working copy info
  const workingCopy = createMemo(() => {
    const nodes = state.nodes || [];
    const wc = nodes.find(n => n.isWorkingCopy);
    return wc;
  });

  const wcChangeId = createMemo(() => {
    const wc = workingCopy();
    if (!wc) return "";
    // Show short change ID with @ prefix
    return `@${wc.changeId?.slice(0, 8) || ""}`;
  });

  const currentBookmark = createMemo(() => {
    const wc = workingCopy();
    if (!wc?.bookmarks?.length) return "";
    // Show first bookmark, indicate if there are more
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

  // Get repo path - try to shorten it
  const repoPath = createMemo(() => {
    const cwd = state.cwd || process.cwd();
    const home = process.env.HOME || "";
    if (home && cwd.startsWith(home)) {
      return "~" + cwd.slice(home.length);
    }
    return cwd;
  });

  return (
    <box height={1} backgroundColor={COLORS.barBg} flexDirection="row">
      {/* Repo path */}
      <box backgroundColor={COLORS.segmentBg} paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.muted}>{repoPath()}</text>
      </box>

      {/* Current bookmark if any */}
      <Show when={currentBookmark()}>
        <box paddingLeft={1} paddingRight={1}>
          <text fg={COLORS.bookmark}>{currentBookmark()}</text>
        </box>
      </Show>

      {/* Working copy change ID */}
      <Show when={wcChangeId()}>
        <box paddingLeft={1}>
          <text fg={COLORS.wc}>{wcChangeId()}</text>
        </box>
      </Show>

      {/* Spacer */}
      <box flexGrow={1} />

      {/* Layout mode */}
      <box paddingRight={1}>
        <text fg={COLORS.muted}>{layoutMode()}</text>
      </box>

      {/* Node count */}
      <box backgroundColor={COLORS.segmentBg} paddingLeft={1} paddingRight={1}>
        <text fg={COLORS.muted}>{nodeCount()} nodes</text>
      </box>
    </box>
  );
}
