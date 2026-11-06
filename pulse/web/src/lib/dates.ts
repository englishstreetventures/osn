/**
 * How a date or time is written, for the two renderings every date on a
 * server-rendered page gets (`components/LocalTime.tsx`):
 *
 * - **Server**: in the item's own zone (its venue's or its series', else UTC),
 *   with the zone named, in the request's locale (`lib/date-locale.ts`). The
 *   browser's first render repeats it exactly, so hydration keeps it as is.
 * - **Viewer**: once the page has mounted, in the reader's own zone and
 *   locale, with no zone named, as the screens are designed.
 */

export interface DateStyle {
  /** True once the reader's own clock may be used: relative words, "now". */
  readonly viewer: boolean;
  /** BCP 47 locale; `undefined` is the reader's own. */
  readonly locale: string | undefined;
  /** IANA zone; `undefined` is the reader's own. */
  readonly timeZone: string | undefined;
  /** Whether the text names its zone: the server's does, since it may not be the reader's. */
  readonly nameZone: boolean;
}

/** The reader's own zone and locale, no zone named: how every screen is designed. */
export const VIEWER: DateStyle = {
  viewer: true,
  locale: undefined,
  timeZone: undefined,
  nameZone: false,
};

/** The zone to format in, if not the runtime's own. */
export const inZone = (style: DateStyle): Intl.DateTimeFormatOptions =>
  style.timeZone ? { timeZone: style.timeZone } : {};

/** The zone to format in, and its short name when the style names it. */
export function zoned(style: DateStyle): Intl.DateTimeFormatOptions {
  const options = inZone(style);
  if (style.nameZone) options.timeZoneName = "short";
  return options;
}

export interface WallClock {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  /** 0–23. */
  readonly hour: number;
  readonly minute: number;
}

/** `date`'s calendar fields in the style's zone (the runtime's own when it names none). */
export function wallClock(date: Date, style: DateStyle): WallClock {
  if (!style.timeZone) {
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: style.timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

/** The short name of `style`'s zone at `date` ("UTC", "NZDT"), or "" when it names none. */
export function zoneName(date: Date, style: DateStyle): string {
  if (!style.nameZone) return "";
  return (
    new Intl.DateTimeFormat(style.locale, { ...inZone(style), timeZoneName: "short" })
      .formatToParts(date)
      .find((p) => p.type === "timeZoneName")?.value ?? ""
  );
}
