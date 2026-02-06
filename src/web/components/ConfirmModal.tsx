import { Show, createEffect } from "solid-js";

export type ConfirmModalProps = {
  open: boolean;
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmModal(props: ConfirmModalProps) {
  let confirmButton: HTMLButtonElement | undefined;
  let cancelButton: HTMLButtonElement | undefined;
  let previouslyFocused: HTMLElement | null = null;

  createEffect(() => {
    if (props.open) {
      previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      queueMicrotask(() => confirmButton?.focus());
      return;
    }
    if (previouslyFocused) queueMicrotask(() => previouslyFocused?.focus());
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      props.onCancel();
      return;
    }

    if (e.key === "Enter") {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement) return;
      if (active instanceof HTMLInputElement) return;
      e.preventDefault();
      e.stopPropagation();
      props.onConfirm();
      return;
    }

    if (e.key !== "Tab" || !confirmButton || !cancelButton) return;
    const active = document.activeElement;
    if (e.shiftKey && active === cancelButton) {
      e.preventDefault();
      confirmButton.focus();
      return;
    }
    if (!e.shiftKey && active === confirmButton) {
      e.preventDefault();
      cancelButton.focus();
    }
  };

  return (
    <Show when={props.open}>
      <div class="jjv-modalBackdrop" role="presentation">
        <div class="jjv-modal" role="dialog" aria-modal="true" aria-label={props.title} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
          <div class="jjv-modalTitle">{props.title}</div>
          <Show when={props.body}>
            <div class="jjv-modalBody">{props.body}</div>
          </Show>
          <div class="jjv-modalActions">
            <button ref={cancelButton} class="jjv-btn jjv-btn--ghost" onClick={() => props.onCancel()}>
              {props.cancelLabel || "Cancel"}
            </button>
            <button
              ref={confirmButton}
              class={`jjv-btn ${props.destructive ? "jjv-btn--danger" : "jjv-btn--primary"}`}
              onClick={() => props.onConfirm()}
            >
              {props.confirmLabel || "Confirm"}
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
