import { onCleanup, onMount, type JSX } from "solid-js";

import { Z_CLASS } from "../lib/z-index";

interface AnimatedModalProps {
  onClose: () => void;
  /**
   * `id` of the element that names this dialog (its title). Wired to
   * `aria-labelledby` so the dialog announces with its heading. Consumers
   * should point this at their existing title element.
   */
  labelledBy?: string;
  /** Fallback accessible name when there is no on-screen title to reference. */
  label?: string;
  children: JSX.Element;
}

/** Selector for the tab-order-relevant focusable descendants of the panel. */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/** Snap the backdrop + panel straight to their final visible state, no animation. */
function showInstantly(backdrop: HTMLElement, panel: HTMLElement) {
  backdrop.style.opacity = "1";
  panel.style.opacity = "1";
  panel.style.transform = "none";
}

export function AnimatedModal(props: AnimatedModalProps) {
  let backdropRef: HTMLDivElement;
  let panelRef: HTMLDivElement;
  let closeButtonRef: HTMLButtonElement | undefined;

  // The element that had focus when the modal opened, so we can restore it on
  // close (mirrors AddToCalendar's popover focus-return pattern).
  let previouslyFocused: HTMLElement | null = null;

  function focusableElements(): HTMLElement[] {
    if (!panelRef) return [];
    return Array.from(panelRef.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  }

  // Trap Tab / Shift+Tab inside the panel and close on Escape.
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      void handleClose();
      return;
    }
    if (e.key !== "Tab") return;

    const focusables = focusableElements();
    if (focusables.length === 0) {
      // Nothing focusable but the panel itself — keep focus on the panel.
      e.preventDefault();
      panelRef?.focus();
      return;
    }

    const first = focusables[0]!;
    const last = focusables[focusables.length - 1]!;
    const active = document.activeElement as HTMLElement | null;

    if (e.shiftKey) {
      if (active === first || !panelRef?.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || !panelRef?.contains(active)) {
      e.preventDefault();
      first.focus();
    }
  }

  onMount(async () => {
    previouslyFocused = document.activeElement as HTMLElement | null;

    // Lock background scroll while the modal is open; restore on cleanup.
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    onCleanup(() => {
      document.body.style.overflow = previousBodyOverflow;
    });

    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => document.removeEventListener("keydown", onKeyDown));

    // Move focus into the panel: the close button if present, else the panel.
    (closeButtonRef ?? panelRef)?.focus();

    if (prefersReducedMotion()) {
      // Reduced motion: skip the imperative animation but still land on the
      // final *visible* state — the panel ships opacity-0, so merely not
      // animating would leave the content invisible.
      showInstantly(backdropRef, panelRef);
      return;
    }

    const { modalEnter } = await import("./Modal.motion");
    modalEnter(backdropRef, panelRef);
  });

  // Restore focus to whatever triggered the modal once it has closed.
  onCleanup(() => previouslyFocused?.focus());

  async function handleClose() {
    if (!prefersReducedMotion()) {
      const { modalExit } = await import("./Modal.motion");
      await modalExit(backdropRef, panelRef);
    }
    props.onClose();
  }

  return (
    <div
      ref={backdropRef}
      // Stacking order is centralised in `lib/z-index` — `Z_CLASS.MODAL` (z-100)
      // is the backdrop/panel layer. A modal-launched popover (AddToCalendar)
      // must paint above this; that invariant lives in `lib/z-index` + its test.
      class={`fixed inset-0 ${Z_CLASS.MODAL} flex items-end justify-center bg-black/70 opacity-0 md:items-center`}
      onClick={() => handleClose()}
    >
      <div
        ref={panelRef}
        class="border-border bg-surface relative max-h-[85dvh] w-full max-w-[480px] overflow-y-auto overscroll-contain rounded-t-xl border px-6 pt-8 pb-[max(2.5rem,env(safe-area-inset-bottom))] opacity-0 md:mb-8 md:max-h-[85vh] md:rounded-lg md:pb-10"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        aria-label={props.labelledBy ? undefined : props.label}
        tabindex="-1"
      >
        <button
          ref={closeButtonRef}
          class="text-text-muted hover:text-text focus-visible:ring-gold/60 absolute top-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-sm border-none bg-transparent text-2xl leading-none transition-colors focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => handleClose()}
          aria-label="Close"
        >
          &times;
        </button>
        {props.children}
      </div>
    </div>
  );
}
