import { createEffect, createMemo, For } from "solid-js";
import { Portal } from "solid-js/web";

import { toasts } from "./store";
import { ToastItem } from "./Toast";
import type { ToasterProps } from "./types";

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
 * ## The top layer is a second axis, and `<Portal>` does not reach it
 *
 * A `showModal()` dialog paints above every stacking context in the document,
 * so once an app has one, no `z-index` here can put a toast over it. That is
 * what {@link ToasterProps.topLayer} is for; see its documentation for when an
 * app needs it.
 *
 * ## No `z-index` here
 *
 * Deliberately. The layer belongs to the consumer's stacking order, so pass it
 * with `class` (e.g. `Z_CLASS.TOAST`). The library this replaced hardcoded
 * `z-index: 9999` into the container's inline style, which silently beat every
 * class a caller passed and parked toasts above the consent banner — the one
 * layer a consumer most needs them under.
 *
 * `topLayer` is the exception to be aware of rather than a hole in that: while
 * it is on and a toast is showing, the container is in the top layer, and the
 * `z-index` decides nothing against anything else that is. Nothing in these
 * apps but a modal dialog is, and a toast and a consent banner do not overlap
 * in practice — but "below consent" is a claim about numbers, and numbers stop
 * applying up there.
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

  let ref: HTMLDivElement | undefined;

  /**
   * In and out of the top layer with the queue, rather than once on mount.
   *
   * Top-layer order is ENTRY order: an element that entered earlier paints
   * below one that entered later. A container that showed itself on mount would
   * therefore sit under every dialog opened afterwards — which is every dialog,
   * since the container is mounted at the page root. Entering as the first
   * toast arrives is what puts it above the sheet that toast is confirming.
   *
   * `manual` rather than `auto`: an auto popover light-dismisses on an outside
   * click and closes on Escape, and a toast that vanishes because the guest
   * tapped the page is not a toast.
   */
  createEffect(() => {
    const el = ref;
    // `showPopover` is missing in jsdom and happy-dom, where nothing is painted
    // and there is no top layer to enter.
    if (!el || !props.topLayer || typeof el.showPopover !== "function") return;
    const wanted = visible().length > 0;
    const shown = el.matches(":popover-open");
    if (wanted && !shown) el.showPopover();
    else if (!wanted && shown) el.hidePopover();
  });

  return (
    <Portal>
      <div
        ref={ref}
        popover={props.topLayer ? "manual" : undefined}
        class={`ui-toaster ui-toaster--${position()}${props.class ? ` ${props.class}` : ""}`}
        style={props.style}
      >
        <For each={visible()}>{(t) => <ToastItem toast={t} class={props.toastClass} />}</For>
      </div>
    </Portal>
  );
}
