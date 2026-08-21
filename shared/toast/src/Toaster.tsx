import { createMemo, For } from "solid-js";
import { Portal } from "solid-js/web";

import { toasts } from "./store";
import { ToastItem } from "./Toast";
import type { ToasterProps } from "./types";

/** The default dwell. Long enough to read a sentence, short enough not to nag. */
const DEFAULT_DURATION = 4000;
const DEFAULT_LIMIT = 4;

/**
 * The toast container. Mount ONE per page, as a sibling of your modals at the
 * page root.
 *
 * ## Why the root, and not wherever the toast is raised
 *
 * The container is `position: fixed`, and a `transform`, `filter`, `contain` or
 * `will-change` on ANY ancestor makes that ancestor the containing block for a
 * fixed descendant — and a stacking context with it. Mounted inside an animated
 * section, a toast is positioned against that section and stacked inside it,
 * below every page-level overlay, whatever `z-index` it carries. That is the
 * bug that put the cire RSVP toast behind the sheet it fires under.
 *
 * `<Portal>` moves the container to `document.body`, which makes this robust by
 * construction rather than by convention.
 *
 * ## No `z-index` here
 *
 * Deliberately. The layer belongs to the consumer's stacking order, so pass it
 * with `class` (e.g. `Z_CLASS.TOAST`). The library this replaced hardcoded
 * `z-index: 9999` into the container's inline style, which silently beat every
 * class a caller passed and parked toasts above the consent banner — the one
 * layer they must never cover.
 */
export function Toaster(props: ToasterProps) {
  const position = () => props.position ?? "bottom-right";
  const limit = () => props.limit ?? DEFAULT_LIMIT;

  /**
   * Newest last, and only the last `limit` of them.
   *
   * No sort: the queue is already in raise order by construction — a new toast
   * is appended, and an in-place update rewrites an entry where it sits rather
   * than moving it. `seq` exists to make that order assertable in tests.
   */
  const visible = createMemo(() => {
    const all = toasts();
    return all.slice(Math.max(0, all.length - limit()));
  });

  return (
    <Portal>
      <div
        class={`osn-toaster osn-toaster--${position()}${props.class ? ` ${props.class}` : ""}`}
        style={props.style}
      >
        <For each={visible()}>
          {(t) => (
            <ToastItem
              toast={t}
              defaultDuration={props.duration ?? DEFAULT_DURATION}
              class={props.toastClass}
            />
          )}
        </For>
      </div>
    </Portal>
  );
}
