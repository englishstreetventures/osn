import Button from "@cire/ui/button";
import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";

import { Z_CLASS } from "../lib/z-index";
import { googleCalendarUrl, icsObjectUrl } from "./calendar";
import type { EventSummary } from "./types";

interface AddToCalendarProps {
  event: EventSummary;
  siteUrl: string;
}

/**
 * Each menu item: a 44px row, filled gold while hovered or focused so the
 * keyboard's position in the menu is as plain as the pointer's.
 */
const ITEM_CLASS =
  "font-body text-text-muted hover:bg-gold hover:text-on-gold focus:bg-gold focus:text-on-gold text-ui-sm tracking-ui-wider inline-flex min-h-11 items-center rounded-sm px-3 uppercase transition-colors duration-200 focus:outline-none";

/** What the menu measures before it has rendered once: two 44px items and its padding. */
const MENU_HEIGHT_ESTIMATE = 110;

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

export function AddToCalendar(props: AddToCalendarProps) {
  const [open, setOpen] = createSignal(false);
  const [position, setPosition] = createSignal<PopoverPosition>({ top: 0, left: 0 });
  const popoverId = createUniqueId();

  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;
  const itemRefs: HTMLAnchorElement[] = [];

  const googleHref = createMemo(() => {
    const url = googleCalendarUrl(props.event, props.siteUrl);
    return isHttpUrl(url) ? url : "#";
  });

  // The .ics blob is built lazily — only allocated the first time the popover
  // opens. Each event card mounts an AddToCalendar; allocating eagerly would
  // hold N blob URLs (one per event) for the document's lifetime even if the
  // user never opens any calendar menu.
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

  function close() {
    setOpen(false);
    detachListeners();
    buttonRef?.focus();
  }

  /**
   * Anchor the (position:fixed) popover to the button: beneath it when the
   * menu fits there, above it when it fits there instead (the "When" row can
   * sit near the bottom of a phone's screen), and beneath it when neither does.
   *
   * The coordinates are viewport coordinates, which is right because the menu
   * is in the top layer: its containing block is the viewport whatever the
   * button's ancestors do, so nothing here has to know about the EventCard's
   * stacking context or the sheet's `overflow: hidden`.
   */
  function updatePosition() {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    // Clamp the (position:fixed) popover into the viewport so it never spills off
    // the right edge on a narrow screen. The popover is min-w-56 (224px);
    // keeping an 8px gutter, the left is bounded by viewport width - panel width.
    const margin = 8;
    const panelWidth = 224;
    const maxLeft = Math.max(margin, window.innerWidth - panelWidth - margin);
    const left = Math.min(rect.left, maxLeft);
    const height = popoverRef?.offsetHeight || MENU_HEIGHT_ESTIMATE;
    const below = rect.bottom + margin;
    const above = rect.top - margin - height;
    const fitsBelow = below + height <= window.innerHeight - margin;
    const top = !fitsBelow && above >= margin ? above : below;
    setPosition({ top, left });
  }

  /** Focus menu item `index`, wrapping at both ends. Called only while the menu is open. */
  function focusItem(index: number) {
    const count = itemRefs.length;
    itemRefs[((index % count) + count) % count]?.focus();
  }

  /**
   * The menu-button keyboard, while the menu is open: the arrows move and wrap,
   * Home and End jump, Escape closes back to the trigger. All four movement keys
   * are claimed, because the menu's DOM sits inside the sheet's scrollport and
   * an unclaimed arrow would scroll the sheet under the fixed menu. Tab closes
   * to the trigger WITHOUT claiming the key, so the browser's own Tab then
   * moves on from there, as it would from a closed menu.
   */
  function onKeyDown(e: KeyboardEvent) {
    // The trigger handles its own keys (see `onTriggerKeyDown`).
    if (e.target === buttonRef && e.key !== "Escape" && e.key !== "Tab") return;
    const current = itemRefs.indexOf(document.activeElement as HTMLAnchorElement);
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        return;
      case "Tab":
        close();
        return;
      case "ArrowDown":
        e.preventDefault();
        focusItem(current + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        focusItem(current - 1);
        return;
      case "Home":
        e.preventDefault();
        focusItem(0);
        return;
      case "End":
        e.preventDefault();
        focusItem(itemRefs.length - 1);
        return;
    }
  }

  /** ArrowDown or ArrowUp on the trigger opens the menu on its first or last item. */
  function onTriggerKeyDown(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const target = e.key === "ArrowDown" ? 0 : -1;
    if (open()) focusItem(target);
    else openMenu(target);
  }

  function onDocumentPointer(e: MouseEvent) {
    const target = e.target as Node | null;
    if (!target) return;
    if (popoverRef?.contains(target)) return;
    if (buttonRef?.contains(target)) return;
    setOpen(false);
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

  // Listeners attach only while the popover is open. N event cards mounted at
  // first paint don't each install 4 global handlers — they install zero. On
  // close (or unmount via the `onCleanup` chain below) every listener detaches.
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

  // Catch the rare case where the component unmounts while open (e.g. the
  // parent EventCard is removed) — detach without firing close() since there
  // is no button left to focus.
  onCleanup(detachListeners);

  function openMenu(focusIndex: number) {
    ensureIcsHref();
    updatePosition();
    attachListeners();
    setOpen(true);
    queueMicrotask(() => focusItem(focusIndex));
  }

  function toggle() {
    if (open()) {
      setOpen(false);
      detachListeners();
      return;
    }
    openMenu(0);
  }

  return (
    <>
      <Button
        ref={buttonRef}
        variant="link"
        size="md"
        class="min-h-11 self-start"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
      >
        Add to calendar
      </Button>
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
            // element throws `InvalidStateError`.
            queueMicrotask(() => {
              if (!el.isConnected) return;
              el.showPopover();
              // Now it has a height to measure, place it again: above the
              // trigger if it does not fit below.
              updatePosition();
            });
          }}
          id={popoverId}
          role="menu"
          aria-label="Add to calendar options"
          // `inset-auto m-0` undo the user-agent styles a `popover` carries
          // (`inset: 0; margin: auto`), which would otherwise fight the
          // measured `top`/`left` below and stretch the box across the
          // viewport.
          class={`border-border bg-surface-raised fixed ${Z_CLASS.MODAL_POPOVER} inset-auto m-0 flex max-w-[calc(100vw-1rem)] min-w-56 flex-col gap-1 rounded-sm border p-2 shadow-lg`}
          style={{ top: `${position().top}px`, left: `${position().left}px` }}
        >
          <a
            ref={(el) => (itemRefs[0] = el)}
            role="menuitem"
            tabindex="-1"
            href={googleHref()}
            target="_blank"
            rel="noopener noreferrer"
            class={ITEM_CLASS}
            onClick={() => setOpen(false)}
          >
            Google Calendar
          </a>
          <a
            ref={(el) => (itemRefs[1] = el)}
            role="menuitem"
            tabindex="-1"
            href={icsHref() ?? "#"}
            download={filename()}
            class={ITEM_CLASS}
            onClick={() => setOpen(false)}
          >
            Apple / Outlook (.ics)
          </a>
        </div>
      </Show>
    </>
  );
}
