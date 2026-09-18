import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";

import { Z_CLASS } from "../lib/z-index";
import { googleCalendarUrl, icsObjectUrl } from "./calendar";
import type { EventSummary } from "./types";

interface AddToCalendarProps {
  event: EventSummary;
  siteUrl: string;
  /**
   * Visual weight of the trigger. `"outline"` (default) matches the secondary
   * card buttons; `"primary"` is a filled-gold call-to-action for the details
   * view, where Add-to-Calendar is the headline action.
   */
  variant?: "outline" | "primary";
}

const TRIGGER_CLASS = {
  outline:
    "border-border font-body text-text-muted hover:border-gold hover:text-gold-ink rounded-sm border bg-transparent px-5 py-2.5 text-ui-sm tracking-ui-wider uppercase transition-colors duration-200",
  primary:
    "border-gold bg-gold text-bg font-body hover:bg-transparent hover:text-gold-ink inline-flex items-center gap-2 rounded-sm border px-5 py-2.5 text-ui-sm tracking-ui-wider uppercase transition-colors duration-200",
} satisfies Record<NonNullable<AddToCalendarProps["variant"]>, string>;

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
  let firstItemRef: HTMLAnchorElement | undefined;

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
   * Anchor the (position:fixed) popover beneath the button.
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
    setPosition({ top: rect.bottom + 8, left });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
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

  function toggle() {
    if (open()) {
      setOpen(false);
      detachListeners();
      return;
    }
    ensureIcsHref();
    updatePosition();
    attachListeners();
    setOpen(true);
    queueMicrotask(() => firstItemRef?.focus());
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        class={TRIGGER_CLASS[props.variant ?? "outline"]}
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
      >
        <Show when={props.variant === "primary"}>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="4" width="18" height="18" rx="2" />
            <path d="M16 2v4M8 2v4M3 10h18" />
          </svg>
        </Show>
        Add to Calendar
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
            // element throws `InvalidStateError`.
            queueMicrotask(() => {
              if (el.isConnected) el.showPopover();
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
            ref={firstItemRef}
            role="menuitem"
            href={googleHref()}
            target="_blank"
            rel="noopener noreferrer"
            class="font-body text-text-muted hover:bg-gold hover:text-bg focus:bg-gold focus:text-bg text-ui-sm tracking-ui-wider rounded-sm px-3 py-2 uppercase transition-colors duration-200"
            onClick={() => setOpen(false)}
          >
            Google Calendar
          </a>
          <a
            role="menuitem"
            href={icsHref() ?? "#"}
            download={filename()}
            class="font-body text-text-muted hover:bg-gold hover:text-bg focus:bg-gold focus:text-bg text-ui-sm tracking-ui-wider rounded-sm px-3 py-2 uppercase transition-colors duration-200"
            onClick={() => setOpen(false)}
          >
            Apple / Outlook (.ics)
          </a>
        </div>
      </Show>
    </>
  );
}
