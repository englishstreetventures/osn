import { createMemo, createSignal, createUniqueId, onCleanup, Show } from "solid-js";
import { Portal } from "solid-js/web";
import type { EventSummary } from "./types";
import { googleCalendarUrl, icsObjectUrl } from "./calendar";

interface AddToCalendarProps {
  event: EventSummary;
  siteUrl: string;
}

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
   * Anchor the (portalled, position:fixed) popover beneath the button. The
   * popover lives at document.body so it escapes the EventCard's stacking
   * context — without that escape it gets painted under sibling cards
   * regardless of z-index.
   */
  function updatePosition() {
    if (!buttonRef) return;
    const rect = buttonRef.getBoundingClientRect();
    setPosition({ top: rect.bottom + 8, left: rect.left });
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
    // Capture-phase scroll catches nested scroll containers too — the popover
    // is portalled, so any ancestor scroll would otherwise drift it away from
    // the anchor button.
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
        class="rounded-sm border border-border bg-transparent px-5 py-2.5 font-body text-[0.82rem] uppercase tracking-[0.12em] text-text-muted transition-colors duration-200 hover:border-gold hover:text-gold"
        aria-haspopup="menu"
        aria-expanded={open()}
        aria-controls={popoverId}
        onClick={toggle}
      >
        Add to Calendar
      </button>
      <Show when={open()}>
        <Portal>
          <div
            ref={popoverRef}
            id={popoverId}
            role="menu"
            aria-label="Add to calendar options"
            // z-90 sits below AnimatedModal (z-100) — modals always win — and
            // above every event card / page-level content. The popover is
            // portalled to <body>, so this z-index isn't trapped inside the
            // EventCard's stacking context.
            class="fixed z-90 flex min-w-[14rem] flex-col gap-1 rounded-sm border border-border bg-surface-raised p-2 shadow-lg"
            style={{ top: `${position().top}px`, left: `${position().left}px` }}
          >
            <a
              ref={firstItemRef}
              role="menuitem"
              href={googleHref()}
              target="_blank"
              rel="noopener noreferrer"
              class="rounded-sm px-3 py-2 font-body text-[0.82rem] uppercase tracking-[0.12em] text-text-muted transition-colors duration-200 hover:bg-gold hover:text-bg focus:bg-gold focus:text-bg focus:outline-none"
              onClick={() => setOpen(false)}
            >
              Google Calendar
            </a>
            <a
              role="menuitem"
              href={icsHref() ?? "#"}
              download={filename()}
              class="rounded-sm px-3 py-2 font-body text-[0.82rem] uppercase tracking-[0.12em] text-text-muted transition-colors duration-200 hover:bg-gold hover:text-bg focus:bg-gold focus:text-bg focus:outline-none"
              onClick={() => setOpen(false)}
            >
              Apple / Outlook (.ics)
            </a>
          </div>
        </Portal>
      </Show>
    </>
  );
}
