import { createMemo, createSignal, onCleanup } from "solid-js";

import { googleCalendarUrl, icsObjectUrl } from "./calendar";
import { LinkMenu } from "./LinkMenu";
import type { EventSummary } from "./types";

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

/**
 * "Add to calendar" on the date row of the details panel's key facts, and its
 * menu of two calendars: Google Calendar, and an `.ics` file for Apple and
 * Outlook. The menu, its keys and where it paints are {@link LinkMenu}'s.
 */
export function AddToCalendar(props: AddToCalendarProps) {
  const googleHref = createMemo(() => {
    const url = googleCalendarUrl(props.event, props.siteUrl);
    return isHttpUrl(url) ? url : "#";
  });

  // The .ics blob is built lazily — only allocated the first time the menu
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

  return (
    <LinkMenu
      label="Add to calendar"
      menuLabel="Add to calendar options"
      onOpen={ensureIcsHref}
      items={[
        { label: "Google Calendar", href: googleHref() },
        { label: "Apple / Outlook (.ics)", href: icsHref() ?? "#", download: filename() },
      ]}
    />
  );
}
