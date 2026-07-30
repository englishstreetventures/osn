/**
 * Mobile presentation of the composed preview. The builder's wide layout keeps
 * `PreviewPane` sticky beside the form; below that breakpoint there's no room
 * for a side-by-side column, so the "Preview" button next to the section tabs
 * opens the SAME `PreviewPane` here instead — one preview, two presentations,
 * never two markup sources to drift apart.
 */

import { Show } from "solid-js";
import { Portal } from "solid-js/web";

import PreviewPane, { type PreviewPaneProps } from "./PreviewPane";

export default function PreviewModal(
  props: PreviewPaneProps & { open: boolean; onClose: () => void },
) {
  return (
    <Show when={props.open}>
      {/* Portalled to document.body: the dashboard shell sets `container-type`
          on its layout boxes, which brings `contain: layout` with it and makes
          them the containing block for `position: fixed` descendants. */}
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) props.onClose();
          }}
        >
          {/* Distinct from `PreviewPane`'s own inner `aria-label="Invite
              preview"` figure — two elements sharing one accessible name would
              make `getByLabelText("Invite preview")` ambiguous whenever both
              this modal and the sticky side pane are mounted at once. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Invite preview modal"
            class="border-border bg-bg flex max-h-[85vh] w-full max-w-sm flex-col gap-4 overflow-y-auto rounded-sm border p-4"
          >
            <div class="flex items-center justify-between gap-2">
              <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
                Live preview
              </p>
              <button
                type="button"
                onClick={props.onClose}
                class="font-body text-text-muted hover:text-text text-[0.78rem]"
              >
                Close
              </button>
            </div>
            <PreviewPane {...props} />
          </div>
        </div>
      </Portal>
    </Show>
  );
}
