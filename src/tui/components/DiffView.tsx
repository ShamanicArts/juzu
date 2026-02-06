import { Show, createMemo } from "solid-js";
import { RGBA } from "@opentui/core";
import { UI_TOKENS } from "../../core/ui-tokens";
import { mixHex } from "../../core/color-utils";

interface DiffViewProps {
  width: number;
  height: number;
  diff: string;
  themeVersion?: number;
  title?: string;
}

export function DiffView(props: DiffViewProps) {
  const bg = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.bg0);
  });
  const muted = createMemo(() => {
    props.themeVersion;
    return RGBA.fromHex(UI_TOKENS.slate.textMuted);
  });
  const colors = createMemo(() => {
    props.themeVersion;
    const diffTheme = ((UI_TOKENS as unknown as { diff?: Record<string, string> }).diff) || {};
    return {
      lineNumberFg: UI_TOKENS.slate.textMuted,
      lineNumberBg: UI_TOKENS.slate.bg1,
      contextBg: diffTheme.contextBg || UI_TOKENS.slate.bg0,
      contextContentBg: diffTheme.contextContentBg || UI_TOKENS.slate.bg0,
      addedBg: diffTheme.addedBg || mixHex(UI_TOKENS.slate.bg0, UI_TOKENS.semantic.fileAdd, 0.48),
      removedBg: diffTheme.removedBg || mixHex(UI_TOKENS.slate.bg0, UI_TOKENS.semantic.fileDel, 0.48),
      addedContentBg: diffTheme.addedContentBg || mixHex(UI_TOKENS.slate.bg0, UI_TOKENS.semantic.fileAdd, 0.48),
      removedContentBg: diffTheme.removedContentBg || mixHex(UI_TOKENS.slate.bg0, UI_TOKENS.semantic.fileDel, 0.48),
      addedSignColor: diffTheme.addedSignColor || UI_TOKENS.semantic.fileAdd,
      removedSignColor: diffTheme.removedSignColor || UI_TOKENS.semantic.fileDel,
      addedLineNumberBg: UI_TOKENS.slate.bg1,
      removedLineNumberBg: UI_TOKENS.slate.bg1,
      fg: UI_TOKENS.slate.text,
    };
  });
  const diffHeight = createMemo(() => Math.max(1, props.height - (props.title ? 1 : 0)));

  return (
    <box width={props.width} height={props.height} backgroundColor={bg()}>
      <Show when={props.title}>
        <text fg={muted()}>{props.title}</text>
      </Show>
      <Show
        when={(props.diff || "").trim().length > 0}
        fallback={
          <box width={props.width} height={diffHeight()} justifyContent="center" alignItems="center">
            <text fg={muted()}>No diff available for selected change</text>
          </box>
        }
      >
        <diff
          id="full-diff"
          width={props.width}
          height={diffHeight()}
          diff={props.diff}
          view="unified"
          showLineNumbers={true}
          lineNumberFg={colors().lineNumberFg}
          lineNumberBg={colors().lineNumberBg}
          contextBg={colors().contextBg}
          addedBg={colors().addedBg}
          removedBg={colors().removedBg}
          addedContentBg={colors().addedContentBg}
          removedContentBg={colors().removedContentBg}
          contextContentBg={colors().contextContentBg}
          addedSignColor={colors().addedSignColor}
          removedSignColor={colors().removedSignColor}
          addedLineNumberBg={colors().addedLineNumberBg}
          removedLineNumberBg={colors().removedLineNumberBg}
          fg={colors().fg}
          wrapMode="char"
        />
      </Show>
    </box>
  );
}
