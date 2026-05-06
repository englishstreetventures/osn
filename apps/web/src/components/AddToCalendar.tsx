import { createMemo, createSignal, createUniqueId, onCleanup, onMount, Show } from "solid-js";
import type { EventSummary } from "./types";
import { googleCalendarUrl, icsObjectUrl } from "./calendar";

interface AddToCalendarProps {
  event: EventSummary;
  siteUrl: string;
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
  const popoverId = createUniqueId();

  let buttonRef: HTMLButtonElement | undefined;
  let popoverRef: HTMLDivElement | undefined;
  let firstItemRef: HTMLAnchorElement | undefined;

  // Build the Google Calendar URL eagerly (cheap) and validate it parses
  // before exposing it. Falls back to "#" if anything looks off.
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
    buttonRef?.focus();
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!open()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  function onDocumentPointer(e: MouseEvent) {
    if (!open()) return;
    const target = e.target as Node | null;
    if (!target) return;
    if (popoverRef?.contains(target)) return;
    if (buttonRef?.contains(target)) return;
    setOpen(false);
  }

  onMount(() => {
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onDocumentPointer);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onDocumentPointer);
    });
  });

  function toggle() {
    setOpen((v) => {
      const next = !v;
      if (next) {
        // Allocate the .ics blob URL on first open — see comment near
        // `icsHref`. Idempotent thereafter.
        ensureIcsHref();
        // Focus the first menu item once it renders.
        queueMicrotask(() => firstItemRef?.focus());
      }
      return next;
    });
  }

  return (
    <div class="relative inline-block">
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
        <div
          ref={popoverRef}
          id={popoverId}
          role="menu"
          aria-label="Add to calendar options"
          class="absolute left-0 top-full z-50 mt-2 flex min-w-[14rem] flex-col gap-1 rounded-sm border border-border bg-surface-raised p-2 shadow-lg"
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
      </Show>
    </div>
  );
}
