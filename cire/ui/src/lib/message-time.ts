/**
 * How an enquiry thread reads time: the order its messages go in, where a new
 * segment of the conversation opens, and the words that say when.
 *
 * A thread shows no time inside a message. A segment opens when more than an
 * hour has passed since the message before it, or when the date changes, and
 * one centred line opens each segment: "Today 10:05 am", "Yesterday 6:20 pm",
 * "Tue 11:30 am" from two to six days back, "Wed 14 Oct, 9:12 am" before that,
 * with the year for another year. The date change also breaks a segment so the
 * clock time a tapped message shows can never sit under a line naming the day
 * before. (The owner's answers on englishstreetventures/osn#1850.)
 *
 * Days are counted on the calendar, not in 24-hour spans: a day the clocks
 * change on is 23 or 25 hours long, and an elapsed-time count calls yesterday
 * "today" across it. The calendar date is read in the zone the labels are
 * written in, so the two can never disagree.
 *
 * The names (weekday, month, the am/pm mark) and the clock come from the
 * reader's locale through `Intl`; the order of the parts is fixed, as the
 * owner approved it. Every function takes `now`, `locale` and `timeZone` so a
 * test can pin them; a component passes none.
 *
 * A time `Date` cannot hold — not a number, or beyond its ±8.64e15ms range —
 * reads as nothing at all: an empty label, no divider of its own, rather than a
 * `RangeError` that would take the whole thread down with it.
 */

interface TimeOptions {
  /** The moment "today" is measured from; `Date.now()` when left out. */
  readonly now?: number;
  /** A BCP 47 tag; the runtime's own when left out. */
  readonly locale?: string;
  /** An IANA zone; the runtime's own when left out. */
  readonly timeZone?: string;
}

/** What these functions need of a message. */
interface Timed {
  readonly sentAt: number;
}

/** The furthest from 1970 a `Date` reaches, either way, in milliseconds. */
const DATE_LIMIT_MS = 8.64e15;

/** Whether `at` is a time `Date` and `Intl` can read. */
export function usableTime(at: number): boolean {
  return Number.isFinite(at) && Math.abs(at) <= DATE_LIMIT_MS;
}

/** More than this since the message before, and a new segment opens. */
const SEGMENT_GAP_MS = 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One formatter per locale, zone and shape. Building an `Intl.DateTimeFormat`
 * costs far more than formatting with one, and a thread formats every message
 * up to three times.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(
  locale: string | undefined,
  timeZone: string | undefined,
  fields: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""}|${timeZone ?? ""}|${JSON.stringify(fields)}`;
  let found = formatters.get(key);
  if (!found) {
    found = new Intl.DateTimeFormat(locale, { ...fields, timeZone });
    formatters.set(key, found);
  }
  return found;
}

/** The parts of a date this module reads; a part the format leaves out is absent. */
interface DateParts {
  year?: string;
  month?: string;
  day?: string;
  weekday?: string;
}

/** The value of each part read, so a locale's own literals never leak in. */
function parts(at: number, fmt: Intl.DateTimeFormat): DateParts {
  const out: DateParts = {};
  for (const part of fmt.formatToParts(at)) {
    if (
      part.type === "year" ||
      part.type === "month" ||
      part.type === "day" ||
      part.type === "weekday"
    ) {
      out[part.type] = part.value;
    }
  }
  return out;
}

/**
 * The calendar date of `at` in `timeZone`, as a whole number of days. Read in
 * Latin digits whatever the reader's locale, since it is arithmetic, not text.
 */
function calendarDay(at: number, timeZone: string | undefined): number {
  const p = parts(
    at,
    formatter("en-US-u-nu-latn", timeZone, { year: "numeric", month: "numeric", day: "numeric" }),
  );
  return Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)) / DAY_MS;
}

/**
 * The messages oldest first, as a new array. The input is read from its end,
 * because the API lists a thread newest first, ties included: two messages in
 * one millisecond then come out in the order they were sent. Each goes in
 * after every message no later than it, so the order is stable, and a list
 * that arrives in order costs one comparison a message. A message with no
 * usable time goes last.
 *
 * By hand rather than `toSorted`: this package compiles against ES2022, the
 * guest site's browser floor, which has no `toSorted` or `toReversed`.
 */
export function orderMessages<T extends Timed>(messages: readonly T[]): T[] {
  const key = (m: T) => (usableTime(m.sentAt) ? m.sentAt : Number.POSITIVE_INFINITY);
  const out: T[] = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    let at = out.length;
    while (at > 0 && key(out[at - 1]!) > key(message)) at--;
    out.splice(at, 0, message);
  }
  return out;
}

/**
 * Ordered messages cut into segments. A message with no usable time joins the
 * segment before it, and opens the first one if it comes first.
 */
export function segmentMessages<T extends Timed>(
  ordered: readonly T[],
  options: Pick<TimeOptions, "timeZone"> = {},
): T[][] {
  const segments: T[][] = [];
  let lastAt: number | undefined;
  /** The last timed message's calendar day, kept so each day is read once. */
  let lastDay: number | undefined;
  for (const message of ordered) {
    const current = segments.at(-1);
    if (!usableTime(message.sentAt)) {
      if (current === undefined) segments.push([message]);
      else current.push(message);
      continue;
    }
    const day = calendarDay(message.sentAt, options.timeZone);
    const opens =
      current === undefined ||
      lastAt === undefined ||
      message.sentAt - lastAt > SEGMENT_GAP_MS ||
      day !== lastDay;
    if (opens) segments.push([message]);
    else current.push(message);
    lastAt = message.sentAt;
    lastDay = day;
  }
  return segments;
}

/** The clock time alone: "9:12 am". */
export function clockTime(at: number, options: TimeOptions = {}): string {
  if (!usableTime(at)) return "";
  return formatter(options.locale, options.timeZone, {
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** The line that opens a segment. */
export function dividerLabel(at: number, options: TimeOptions = {}): string {
  if (!usableTime(at)) return "";
  const now = options.now ?? Date.now();
  const clock = clockTime(at, options);
  const daysBack = calendarDay(now, options.timeZone) - calendarDay(at, options.timeZone);
  if (daysBack === 0) return `Today ${clock}`;
  if (daysBack === 1) return `Yesterday ${clock}`;
  const p = parts(
    at,
    formatter(options.locale, options.timeZone, {
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric",
    }),
  );
  if (daysBack > 1 && daysBack < 7) return `${p.weekday} ${clock}`;
  const nowYear = parts(now, formatter("en-US-u-nu-latn", options.timeZone, { year: "numeric" }));
  const atYear = parts(at, formatter("en-US-u-nu-latn", options.timeZone, { year: "numeric" }));
  const year = atYear.year === nowYear.year ? "" : ` ${p.year}`;
  return `${p.weekday} ${p.day} ${p.month}${year}, ${clock}`;
}

/** The whole date and the time, for the message's info: "Thursday 29 October 2026 at 6:20 pm". */
export function fullDateTime(at: number, options: TimeOptions = {}): string {
  if (!usableTime(at)) return "";
  const p = parts(
    at,
    formatter(options.locale, options.timeZone, {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
  );
  return `${p.weekday} ${p.day} ${p.month} ${p.year} at ${clockTime(at, options)}`;
}
