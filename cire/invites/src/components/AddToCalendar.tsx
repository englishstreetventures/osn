import { buttonClass } from "@cire/ui/button";
import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";

import { Z_CLASS } from "../lib/z-index";
import { googleCalendarUrl, icsObjectUrl } from "./calendar";
import type { EventSummary } from "./types";

interface AddToCalendarProps {
  event: EventSummary;
  siteUrl: string;
}

/**
 * The trigger: a text action on the date row of the details panel's key facts,
 * like "Open in maps" on the venue row under it. Not a box: the sheet's way
 * forward is its badge to the RSVP form, and a boxed button in the content
 * would compete with it. `touchLink`, because the invite is read on a
 * phone, where an underline that waits for hover never shows, and nothing else
 * would mark these words as something to press. `min-h-11` keeps a 44px target
 * round a line of text.
 */
const TRIGGER_CLASS = `${buttonClass({ variant: "touchLink", size: "md" })} min-h-11`;

/** Each item a 44px row, filled gold while it holds focus or the pointer. */
const ITEM_CLASS =
  "font-body text-text-muted hover:bg-gold hover:text-on-gold focus:bg-gold focus:text-on-gold text-ui-sm tracking-ui-wider flex min-h-11 items-center rounded-sm px-3 uppercase transition-colors duration-200 focus:outline-none";

/** The menu's `min-w-56`, for placing it before it has been measured. */
const MENU_WIDTH = 224;

/**
 * The menu's height before it has been measured: two 44px items, the `gap-1`
 * between them, the `p-2` round them and the border. Used for the first
 * placement only; once shown, the menu is measured and placed again.
 */
const ESTIMATED_MENU_HEIGHT = 2 * 44 + 4 + 2 * 8 + 2;

/** Space kept between the menu, its trigger and the viewport's edges. */
const MARGIN = 8;

interface PopoverPosition {
  top: number;
  left: number;
}

/**
 * Sanitise a free-form event name into a printable-ASCII filename suitable
 * for `download="..."`. Anything outside [A-Za-z0-9-_] becomes `_`.
 */
function sanitiseFilename(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9-_]/g, "_");
  return cleaned.length > 0 ? cleaned : "event";
}

/**
 * Validate that a candidate URL string parses and uses an http(s) scheme.
 * Cheap defence against ever surfacing a non-http calendar link.
 */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * "Add to calendar" and its menu of two calendars.
 *
 * ## Keyboard
 *
 * The ARIA menu-button pattern. Enter or Space on the trigger opens the menu on
 * its first item, ArrowDown too, and ArrowUp on its last. In the menu ArrowDown
 * and ArrowUp move between the items and wrap round, Home and End go to either
 * end, and Escape closes it with focus back on the trigger. Choosing a calendar
 * closes it onto the trigger too: the item goes with the menu, and focus left
 * on it would fall to the document's `<body>`, outside the modal sheet. Tab
 * closes it as well, from the trigger, so the browser carries on to whatever
 * comes next.
 * The items are out of the Tab order (`tabindex="-1"`); the arrows reach them.
 *
 * Every key the menu takes cancels its default action. The menu's DOM sits
 * inside the sheet's focusable scrollport, where an arrow, Home or End would
 * otherwise scroll the sheet under a menu fixed to the viewport.
 */
export function AddToCalendar(props: AddToCalendarProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PopoverPosition>({ top: 0, left: 0 });
  const popoverId = createUniqueId();

  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;

  const googleHref = createMemo(() => {
    const url = googleCalendarUrl(props.event, props.siteUrl);
    return isHttpUrl(url) ? url : "#";
  });

  // The .ics blob is built lazily — only allocated the first time the popover
  // opens. Allocating on mount would hold a blob URL for the document's
  // lifetime for every sheet a guest opens, whether or not they ever ask for a
  // calendar.
  //
  // Track every URL we create so we can revoke intermediates if `props.event`
  // or `props.siteUrl` ever change (also covers the unmount path).
  const [icsHref, setIcsHref] = createSignal<string | null>(null);
  const allocated = new Set<string>();

  function ensureIcsHref(): string {
    const existing = icsHref();
    if (existing) return existing;
    const url = icsObjectUrl(props.event, props.siteUrl);
    allocated.add(url);
    setIcsHref(url);
    return url;
  }

  onCleanup(() => {
    for (const url of allocated) {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // jsdom or older browsers may throw on a synthetic URL; ignore.
      }
    }
    allocated.clear();
  });

  const filename = () => `${sanitiseFilename(props.event.name)}.ics`;

  /** The menu's items, in order. */
  function items(): HTMLElement[] {
    return popoverRef ? [...popoverRef.querySelectorAll<HTMLElement>('[role="menuitem"]')] : [];
  }

  /** Close the menu, leaving focus wherever it is. */
  function dismiss() {
    setOpen(false);
    detachListeners();
  }

  /** Close the menu and hand focus back to its trigger. */
  function close() {
    dismiss();
    buttonRef?.focus();
  }

  /**
   * Anchor the (position:fixed) popover to the button: under it when it fits,
   * over it when only that fits, and under it when neither does (a viewport
   * shorter than the menu either way, where under is where a reader looks
   * first). Sideways it is clamped inside the viewport with the same gutter.
   *
   * The coordinates are viewport coordinates, which is right because the menu
   * is in the top layer: its containing block is the viewport whatever the
   * button's ancestors do, so nothing here has to know about the sheet's
   * scrollport or its `overflow: hidden`.
   */
  function updatePosition() {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    const width = popoverRef?.offsetWidth || MENU_WIDTH;
    const height = popoverRef?.offsetHeight || ESTIMATED_MENU_HEIGHT;
    const maxLeft = Math.max(MARGIN, window.innerWidth - width - MARGIN);
    const left = Math.min(rect.left, maxLeft);
    const below = rect.bottom + MARGIN;
    const above = rect.top - MARGIN - height;
    const fitsBelow = below + height <= window.innerHeight - MARGIN;
    setPosition({ top: !fitsBelow && above >= MARGIN ? above : below, left });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  /** Move focus within the open menu: the arrows wrap, Home and End jump. */
  function onMenuKeyDown(e: KeyboardEvent) {
    const list = items();
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement as HTMLElement);
    let next: number;
    switch (e.key) {
      case "ArrowDown":
        next = at < 0 ? 0 : (at + 1) % list.length;
        break;
      case "ArrowUp":
        next = at < 0 ? list.length - 1 : (at - 1 + list.length) % list.length;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = list.length - 1;
        break;
      case "Tab":
        // Back to the trigger, then let the browser's own Tab move on from it.
        close();
        return;
      default:
        return;
    }
    e.preventDefault();
    list[next]?.focus();
  }

  function onDocumentPointer(e: MouseEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (popoverRef?.contains(target)) return;
    if (buttonRef?.contains(target)) return;
    dismiss();
  }

  // rAF-throttled reposition: scroll / resize can fire many times per frame on
  // touch-momentum scroll, and each call would read layout (`getBoundingClientRect`)
  // and write a signal. Coalesce into one update per frame.
  let rafPending = false;
  function onScrollOrResize() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      updatePosition();
    });
  }

  // Listeners attach only while the popover is open, and detach on every close
  // (or unmount via the `onCleanup` below).
  let listenersAttached = false;
  function attachListeners() {
    if (listenersAttached) return;
    listenersAttached = true;
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onDocumentPointer);
    // Capture-phase scroll catches nested scroll containers too — the menu is
    // positioned against the viewport, so a scroll of the sheet it sits in
    // would otherwise drift it away from the anchor button.
    window.addEventListener("scroll", onScrollOrResize, { capture: true, passive: true });
    window.addEventListener("resize", onScrollOrResize);
  }
  function detachListeners() {
    if (!listenersAttached) return;
    listenersAttached = false;
    document.removeEventListener("keydown", onKeyDown);
    document.removeEventListener("mousedown", onDocumentPointer);
    window.removeEventListener("scroll", onScrollOrResize, { capture: true });
    window.removeEventListener("resize", onScrollOrResize);
  }

  // Catch the rare case where the component unmounts while open — detach
  // without firing close() since there is no button left to focus.
  onCleanup(detachListeners);

  /** Open the menu with focus on its first item, or its last. */
  function show(focus: "first" | "last") {
    ensureIcsHref();
    updatePosition();
    attachListeners();
    setOpen(true);
    queueMicrotask(() => {
      const list = items();
      (focus === "first" ? list[0] : list.at(-1))?.focus();
    });
  }

  function toggle() {
    if (open()) {
      dismiss();
      return;
    }
    show("first");
  }

  function onTriggerKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    show(e.key === "ArrowDown" ? "first" : "last");
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        class={TRIGGER_CLASS}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        Add to calendar
      </button>
      <Show when={open()}>
        <div
          ref={(el) => {
            popoverRef = el;
            // The top layer, entered from here rather than from a z-index.
            //
            // This menu is opened from INSIDE the details sheet, which is a
            // `showModal()` dialog — and a modal dialog paints above every
            // stacking context in the document by definition, so no `z-index`
            // can put the menu over it. That is the #203 failure exactly
            // ("Add to Calendar doesn't work": the menu rendered behind the
            // sheet, invisible and unclickable), arriving through a different
            // door. Showing a popover puts this in the top layer too.
            //
            // `manual` because this component already owns Escape, the
            // outside-click dismissal and the focus return; `auto` would
            // light-dismiss underneath all three.
            //
            // The attribute is set here rather than written in the JSX so it
            // exists only where the method does. A `[popover]` element that
            // has never been shown is `display: none`, so in an environment
            // without the API — jsdom, or a server render — writing it would
            // hide the menu outright instead of degrading to the z-index.
            if (typeof el.showPopover !== "function") return;
            el.setAttribute("popover", "manual");
            // A microtask later, because a `ref` callback runs BEFORE the
            // element is inserted, and `showPopover()` on a disconnected
            // element throws `InvalidStateError`. Placed again once shown,
            // now that it can be measured.
            queueMicrotask(() => {
              if (!el.isConnected) return;
              el.showPopover();
              updatePosition();
            });
          }}
          id={popoverId}
          role="menu"
          aria-label="Add to calendar options"
          // Focusable by script only, as a menu takes its keys: focus lives on
          // the items, and a click on the menu's own padding lands here, where
          // the arrows still reach the first and last items.
          tabindex="-1"
          onKeyDown={onMenuKeyDown}
          // `inset-auto m-0` undo the user-agent styles a `popover` carries
          // (`inset: 0; margin: auto`), which would otherwise fight the
          // measured `top`/`left` below and stretch the box across the
          // viewport.
          class={`border-border bg-surface-raised fixed ${Z_CLASS.MODAL_POPOVER} inset-auto m-0 flex max-w-[calc(100vw-1rem)] min-w-56 flex-col gap-1 rounded-sm border p-2 shadow-lg`}
          style={{ top: `${position().top}px`, left: `${position().left}px` }}
        >
          <a
            role="menuitem"
            tabindex="-1"
            href={googleHref()}
            target="_blank"
            rel="noopener noreferrer"
            class={ITEM_CLASS}
            onClick={close}
          >
            Google Calendar
          </a>
          <a
            role="menuitem"
            tabindex="-1"
            href={icsHref() ?? "#"}
            download={filename()}
            class={ITEM_CLASS}
            onClick={close}
          >
            Apple / Outlook (.ics)
          </a>
        </div>
      </Show>
    </>
  );
}
