import { onCleanup, onMount, type JSX } from "solid-js";

import { Z_CLASS } from "../lib/z-index";
import { filterThemeVars } from "./invite-theme";

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
  /**
   * Validated theme CSS-variable map (usually a `sectionVars(...)` from
   * `invite-theme.ts`), applied to the panel so the modal follows its owning
   * section's theme. The modal paints outside any themed section wrapper, so
   * the variables must be re-declared here to reach its contents. Empty/absent
   * ⇒ the built-in tokens, unchanged. Keys are filtered through the
   * theme-variable allow-list (`filterThemeVars`) before touching the DOM, so
   * this prop can never become an arbitrary inline-style sink.
   */
  themeVars?: Record<string, string>;
  /**
   * Drop the panel's own bottom padding so a child can own the sheet's bottom
   * edge — used by a full-bleed sticky action bar, which supplies its own
   * safe-area padding. Without this the bar would either float above the
   * panel's padding or have to cancel it with a negative margin, which
   * `position: sticky` resolves against the scrollport and so hoists the bar
   * up over the content instead of extending it down (see RsvpModal).
   */
  flushBottom?: boolean;
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
  let backdropRef!: HTMLDivElement;
  let panelRef!: HTMLDivElement;
  let closeButtonRef: HTMLButtonElement | undefined;
  let scrollRef: HTMLDivElement | undefined;

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

    // Move focus to the SCROLL CONTAINER, not the close button. The button is
    // a sibling of the scrollport, so focusing it leaves the keyboard with
    // nothing to scroll — its nearest scrollable ancestor is the
    // `overflow-hidden` frame, then a `<body>` this component has deliberately
    // locked. Measured before this line changed: Arrow and PageDown moved a
    // scrollable sheet 0px. Focusing the scrollport itself restores that, and
    // lands a screen-reader user on the content with the dialog's own name
    // already announced from the panel. The close button stays first in DOM,
    // so it is still the first stop when tabbing round.
    (scrollRef ?? closeButtonRef ?? panelRef)?.focus();

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
      {/* The panel is a NON-scrolling frame; the scroller is the div below it.
          Keeping the close button out of the scroll container is what stops it
          leaving the viewport on a sheet tall enough to scroll — as an
          `absolute` child of the scroller it used to scroll away with the
          content, leaving Escape or a backdrop tap as the only way out. It also
          gives a sticky footer inside the scroller a containing block that is
          the scrollport itself. */}
      <div
        ref={panelRef}
        class="border-border bg-surface relative flex max-h-[85dvh] w-full max-w-[480px] flex-col overflow-hidden rounded-t-[1.75rem] border opacity-0 md:mb-8 md:max-h-[85vh] md:rounded-lg"
        style={filterThemeVars(props.themeVars)}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={props.labelledBy}
        aria-label={props.labelledBy ? undefined : props.label}
        tabindex="-1"
      >
        {/* No z-index: a positioned box already paints over its non-positioned
            in-flow siblings, so this stays above the scroller without adding a
            magic number outside `lib/z-index`. `bg-surface` (not transparent)
            because content now passes UNDERNEATH the button as it scrolls, and
            an opaque chip is what keeps a guest's name from colliding with the
            glyph. */}
        <button
          ref={closeButtonRef}
          class="text-text-muted hover:text-text focus-visible:ring-gold/60 bg-surface absolute top-2 right-2 flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-none text-2xl leading-none transition-colors focus-visible:ring-2 focus-visible:outline-none"
          onClick={() => handleClose()}
          aria-label="Close"
        >
          &times;
        </button>
        {/* `min-h-0` so this flex item may shrink below its content height —
            without it the panel's `max-h` cannot take effect and nothing
            scrolls.

            `tabindex="0"` makes the scrollport itself focusable, which is what
            gives it a keyboard. Initial focus lands on the close button, and
            that button is now a SIBLING of this box rather than a descendant —
            so without a tab stop here the nearest scrollable ancestor of the
            focused element is the `overflow-hidden` frame, then a `<body>` we
            have deliberately locked, and Arrow/PageDown scroll nothing at all
            until the guest tabs into the content. (Measured: they scrolled 0px.)
            `[tabindex]:not([tabindex="-1"])` is already in FOCUSABLE_SELECTOR,
            so this joins the focus trap cleanly.

            `scroll-pt-14` (56px) keeps focus-driven scrolling clear of the
            close button's 52px-tall footprint: tabbing BACKWARDS scrolls a
            target to the top of the scrollport, which is exactly where the chip
            sits. */}
        <div
          ref={scrollRef}
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region MUST be focusable or it has no keyboard (WCAG 2.1.1; axe `scrollable-region-focusable`). This rule and that one disagree by construction on scrollports, and keyboard operability wins: measured, focus elsewhere left Arrow/PageDown moving this sheet 0px.
          tabindex="0"
          class={`min-h-0 scroll-pt-14 overflow-y-auto overscroll-contain px-6 pt-8 ${
            props.flushBottom ? "pb-0" : "pb-[max(2.5rem,env(safe-area-inset-bottom))] md:pb-10"
          }`}
        >
          {props.children}
        </div>
      </div>
    </div>
  );
}
