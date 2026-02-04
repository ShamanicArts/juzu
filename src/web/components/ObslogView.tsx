import { createEffect } from "solid-js";
import type { ObslogEntry } from "../../core/jj-api";

interface ObslogViewProps {
  entries: ObslogEntry[];
  changeId: string | null;
  selectedIndex: number;
  onSelectIndex: (idx: number) => void;
  onBackToLog: () => void;
}

export function ObslogView(props: ObslogViewProps) {
  let listRef: HTMLDivElement | undefined;

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

  createEffect(() => {
    if (!listRef) return;
    const idx = props.selectedIndex;
    const el = listRef.querySelector(`[data-idx="${idx}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  });

  return (
    <div class="jjv-obslog">
      <div class="jjv-obslog-header">
        <h3>Observation Log {props.changeId && <span class="jjv-obslog-changeid">({props.changeId.slice(0, 8)})</span>}</h3>
        <div class="jjv-muted">j/k navigate, r refresh, g back</div>
      </div>

      {props.entries.length === 0 ? (
        <div class="jjv-obslog-empty">Loading obslog...</div>
      ) : (
        <div class="jjv-obslog-list" ref={(el) => (listRef = el)}>
          {props.entries.map((entry, index) => {
            const argsLine = getArgsFromTags(entry.operationTags);
            return (
              <div
                class={`jjv-obslog-item ${index === props.selectedIndex ? 'jjv-obslog-item--current' : ''}`}
                onClick={() => props.onSelectIndex(index)}
                data-idx={index}
              >
                <div class="jjv-obslog-item__main">
                  <span class={`jjv-obslog-item__wc ${entry.isWorkingCopy ? 'jjv-obslog-item__wc--active' : ''}`}>
                    {entry.isWorkingCopy ? '@' : index === props.selectedIndex ? '▶' : index === 0 ? '●' : '○'}
                  </span>
                  <span class="jjv-obslog-item__commit">{entry.commitId.slice(0, 12)}</span>
                  <span class="jjv-obslog-item__time">{formatTime(entry.time)}</span>
                  {entry.isHidden && <span class="jjv-obslog-item__hidden">hidden</span>}
                  {entry.isConflict && <span class="jjv-obslog-item__conflict">CONFLICT</span>}
                  {entry.isEmpty && <span class="jjv-obslog-item__empty">empty</span>}
                  {entry.bookmarks.length > 0 && (
                    <span class="jjv-obslog-item__bookmarks">
                      ({entry.bookmarks.join(", ")})
                    </span>
                  )}
                </div>
                <div class="jjv-obslog-item__author">{entry.author}</div>
                <div class="jjv-obslog-item__desc">
                  {entry.descriptionTitle || "(no description)"}
                </div>
                <div class="jjv-obslog-item__op">
                  <span class="jjv-obslog-item__op-id">{entry.operationId.slice(0, 12)}</span>
                  <span class="jjv-obslog-item__op-desc">{entry.operationDescription}</span>
                  {argsLine && (
                    <span class="jjv-obslog-item__op-args">{argsLine}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
