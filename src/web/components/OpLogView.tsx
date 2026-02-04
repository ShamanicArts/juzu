import { createEffect, createMemo } from "solid-js";
import type { OpLogEntry } from "../../core/jj-api";

interface OpLogViewProps {
  entries: OpLogEntry[];
  selectedId: string | null;
  onSelectEntry: (id: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  onRestore: () => void;
  onBackToLog: () => void;
}

export function OpLogView(props: OpLogViewProps) {
  let listRef: HTMLDivElement | undefined;

  const formatTime = (timeStr: string) => {
    try {
      // jj op log may return a range like "start - end".
      const start = timeStr.split(" - ")[0] || timeStr;
      const date = new Date(start);
      if (Number.isNaN(date.getTime())) return start.slice(0, 16);
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

  createEffect(() => {
    const id = props.selectedId;
    if (!id || !listRef) return;
    const el = listRef.querySelector(`[data-opid="${CSS.escape(id)}"]`) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest" });
  });

  return (
    <div class="jjv-oplog">
      <div class="jjv-oplog-header">
        <h3>Operation Log</h3>
        <div class="jjv-muted">j/k navigate, Enter restore, u undo, R redo, g back</div>
      </div>

      <div class="jjv-oplog-list" ref={(el) => (listRef = el)}>
        {props.entries.map((entry) => {
          const argsLine = getArgsFromTags(entry.tags);
          return (
            <div
              class={`jjv-oplog-item ${entry.id === props.selectedId ? 'jjv-oplog-item--selected' : ''}`}
              onClick={() => props.onSelectEntry(entry.id)}
              data-opid={entry.id}
            >
              <div class="jjv-oplog-item__main">
                <span class={`jjv-oplog-item__current ${entry.isCurrent ? 'jjv-oplog-item__current--active' : ''}`}>
                  {entry.isCurrent ? '●' : '○'}
                </span>
                <span class="jjv-oplog-item__id">{entry.id.slice(0, 12)}</span>
                <span class="jjv-oplog-item__user">{entry.user}</span>
                <span class="jjv-oplog-item__time">{formatTime(entry.time)}</span>
                <span class="jjv-oplog-item__duration">{entry.duration}</span>
              </div>
              <div class="jjv-oplog-item__desc">{entry.descriptionTitle}</div>
              {argsLine && (
                <div class="jjv-oplog-item__args">{argsLine}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
