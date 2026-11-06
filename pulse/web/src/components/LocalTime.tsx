import type { JSX } from "solid-js";

import { dateLocale } from "../lib/date-locale";
import { type DateStyle, VIEWER } from "../lib/dates";
import { createInBrowser } from "../lib/hydration";

/**
 * The style a date is written in: the server's until the page has mounted
 * (the item's zone, else UTC, named, in the request's locale), the reader's
 * after. `pinZone` keeps the item's zone after mount too, for a screen
 * designed around it (a venue's night, in the venue's time).
 */
function createDateStyle(zone: () => string | null | undefined, pinZone: () => boolean) {
  const inBrowser = createInBrowser();
  return (): DateStyle => {
    const timeZone = zone() || "UTC";
    if (!inBrowser()) return { viewer: false, locale: dateLocale(), timeZone, nameZone: true };
    return pinZone() ? { ...VIEWER, timeZone } : VIEWER;
  };
}

/**
 * An instant, in a `<time datetime>` (ISO 8601, UTC, the same on both sides).
 *
 * The server writes it in the item's own zone (`zone`, else UTC) with the
 * zone named, in the request's locale, so a reader without JavaScript gets a
 * real date. The browser's first render repeats that exactly, so hydration
 * keeps it; once mounted, it is rewritten in the reader's own zone and locale.
 */
export function LocalTime(props: {
  /** The instant, as the API sends it or as a `Date`. */
  value: string | Date;
  /** The item's IANA zone, when the page's data carries one. */
  zone?: string | null;
  /** Keep `zone` after mount instead of the reader's. */
  pinZone?: boolean;
  format: (date: Date, style: DateStyle) => string;
  class?: string;
}): JSX.Element {
  const style = createDateStyle(
    () => props.zone,
    () => props.pinZone ?? false,
  );
  const date = () => new Date(props.value);
  const iso = () => {
    const d = date();
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  };
  return (
    <time datetime={iso()} class={props.class}>
      {props.format(date(), style())}
    </time>
  );
}

/**
 * Text read off the clock rather than an item: today's date, a greeting. The
 * server writes it for "now" in UTC, the browser's first render repeats it,
 * and once mounted it is rewritten from the reader's own clock. See
 * `LocalTime`.
 */
export function LocalNow(props: {
  format: (now: Date, style: DateStyle) => string;
  class?: string;
}): JSX.Element {
  const style = createDateStyle(
    () => null,
    () => false,
  );
  return <span class={props.class}>{props.format(new Date(), style())}</span>;
}
