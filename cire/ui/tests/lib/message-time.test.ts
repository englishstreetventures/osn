import { describe, expect, it } from "vitest";

import {
  clockTime,
  dividerLabel,
  fullDateTime,
  orderMessages,
  segmentMessages,
} from "../../src/lib/message-time";

/**
 * How an enquiry thread reads time: the order, where a new segment opens, and
 * what the line that opens it says (the owner's answers on
 * englishstreetventures/osn#1850). Pinned to one zone and one locale, so a
 * machine in UTC or in `en-US` reads the same strings; the components pass
 * neither and take the reader's own.
 */

const ZONE = { locale: "en-AU", timeZone: "Australia/Sydney" } as const;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** An instant given as Sydney wall-clock time: AEST (+10) before 4 Oct 2026, AEDT (+11) from then to April. */
function sydney(y: number, mo: number, d: number, h: number, mi: number, offset = 10): number {
  return Date.UTC(y, mo - 1, d, h - offset, mi);
}

/** Friday 30 October 2026, 10:30 am in Sydney (AEDT, +11). */
const NOW = sydney(2026, 10, 30, 10, 30, 11);

const at = (sentAt: number, id = String(sentAt)) => ({ id, sentAt });

describe("orderMessages", () => {
  it("puts the oldest first without touching the caller's array", () => {
    const input = [at(3 * HOUR), at(1 * HOUR), at(2 * HOUR)];
    const copy = [...input];
    expect(orderMessages(input).map((m) => m.sentAt)).toEqual([HOUR, 2 * HOUR, 3 * HOUR]);
    expect(input).toEqual(copy);
  });

  it("keeps two sent in one millisecond oldest first when the list arrives newest first", () => {
    // zap lists by (createdAt desc, id desc): the later id comes first.
    const newestFirst = [at(5 * HOUR, "m2"), at(5 * HOUR, "m1"), at(HOUR, "m0")];
    expect(orderMessages(newestFirst).map((m) => m.id)).toEqual(["m0", "m1", "m2"]);
  });

  it("puts a message with no usable time last rather than failing the sort", () => {
    const input = [at(Number.NaN, "bad"), at(2 * HOUR, "b"), at(HOUR, "a")];
    expect(orderMessages(input).map((m) => m.id)).toEqual(["a", "b", "bad"]);
  });
});

describe("segmentMessages", () => {
  const base = sydney(2026, 10, 14, 9, 12, 11);

  it("keeps messages 59 minutes apart in one segment", () => {
    const segments = segmentMessages([at(base), at(base + 59 * MINUTE)], ZONE);
    expect(segments).toHaveLength(1);
  });

  it("opens a segment after a gap of more than an hour", () => {
    const segments = segmentMessages([at(base), at(base + 61 * MINUTE)], ZONE);
    expect(segments.map((s) => s.length)).toEqual([1, 1]);
  });

  it("opens a segment at midnight, however short the gap", () => {
    const late = sydney(2026, 10, 14, 23, 40, 11);
    const segments = segmentMessages([at(late), at(late + 40 * MINUTE)], ZONE);
    expect(segments.map((s) => s.length)).toEqual([1, 1]);
  });

  it("keeps messages exactly an hour apart in one segment", () => {
    const segments = segmentMessages([at(base), at(base + 60 * MINUTE)], ZONE);
    expect(segments).toHaveLength(1);
  });

  it("gives a message with no usable time to the segment before it, and reads on past it", () => {
    const segments = segmentMessages(
      [at(base), at(Number.NaN), at(base + 5 * MINUTE), at(base + 3 * HOUR)],
      ZONE,
    );
    expect(segments.map((s) => s.length)).toEqual([3, 1]);
  });

  it("lets a message with no usable time open the thread, and the next timed one open its own", () => {
    // Today's date on purpose: a timed message must not be compared with the
    // untimed one before it, which `Intl` would read as the present moment.
    const segments = segmentMessages([at(Number.NaN), at(Date.now())], ZONE);
    expect(segments.map((s) => s.length)).toEqual([1, 1]);
  });

  it("returns no segments for no messages", () => {
    expect(segmentMessages([], ZONE)).toEqual([]);
  });
});

describe("dividerLabel", () => {
  const opts = { ...ZONE, now: NOW };

  it("says Today for a time on today's date", () => {
    expect(dividerLabel(sydney(2026, 10, 30, 10, 5, 11), opts)).toBe("Today 10:05 am");
  });

  it("says Yesterday for the day before", () => {
    expect(dividerLabel(sydney(2026, 10, 29, 18, 20, 11), opts)).toBe("Yesterday 6:20 pm");
  });

  it("names the weekday from two to six days back", () => {
    expect(dividerLabel(sydney(2026, 10, 28, 11, 30, 11), opts)).toBe("Wed 11:30 am");
    expect(dividerLabel(sydney(2026, 10, 24, 11, 30, 11), opts)).toBe("Sat 11:30 am");
  });

  it("dates anything seven days back, so it never reads as today's weekday", () => {
    expect(dividerLabel(sydney(2026, 10, 23, 9, 12, 11), opts)).toBe("Fri 23 Oct, 9:12 am");
  });

  it("adds the year only for another year", () => {
    // August: ICU builds disagree on "Sep" and "Sept", "Jun" and "June".
    expect(dividerLabel(sydney(2026, 8, 10, 9, 12), opts)).toBe("Mon 10 Aug, 9:12 am");
    expect(dividerLabel(sydney(2025, 12, 31, 21, 0, 11), opts)).toBe("Wed 31 Dec 2025, 9:00 pm");
  });

  it("counts calendar days across the clock change, not 24-hour spans", () => {
    // Sydney moves to daylight time on Sunday 4 October 2026: that day is 23
    // hours long. A count of elapsed milliseconds calls the 4th "today" on the 5th.
    const midnight4 = sydney(2026, 10, 4, 0, 0, 10);
    const midnight5 = sydney(2026, 10, 5, 0, 0, 11);
    expect(midnight5 - midnight4).toBe(23 * HOUR);
    const nowOn5th = { ...ZONE, now: sydney(2026, 10, 5, 0, 30, 11) };
    expect(dividerLabel(sydney(2026, 10, 4, 0, 50, 10), nowOn5th)).toBe("Yesterday 12:50 am");
  });

  it("counts the days across the end of a short month", () => {
    const firstOfMarch = { ...ZONE, now: sydney(2026, 3, 1, 9, 0, 11) };
    expect(dividerLabel(sydney(2026, 2, 28, 20, 0, 11), firstOfMarch)).toBe("Yesterday 8:00 pm");
  });

  it("dates a time ahead of today rather than naming a weekday", () => {
    // A clock running fast on the sender's side puts a message tomorrow.
    expect(dividerLabel(sydney(2026, 10, 31, 9, 0, 11), opts)).toBe("Sat 31 Oct, 9:00 am");
  });

  it("formats for each locale and zone it is asked for, not the first one it saw", () => {
    const sent = sydney(2026, 10, 29, 18, 20, 11);
    expect(clockTime(sent, { locale: "en-AU", timeZone: "Australia/Sydney" })).toBe("6:20 pm");
    expect(clockTime(sent, { locale: "en-US", timeZone: "Australia/Sydney" })).toBe("6:20 PM");
    expect(clockTime(sent, { locale: "en-AU", timeZone: "Australia/Perth" })).toBe("3:20 pm");
  });

  it("writes no doubled comma and no empty part", () => {
    for (const daysBack of [0, 1, 3, 9, 400]) {
      const label = dividerLabel(NOW - daysBack * 24 * HOUR, opts);
      expect(label).not.toMatch(/,\s*,|\s{2}|^\s|\s$|^,/);
    }
  });

  it("gives an empty label for a time it cannot read, rather than throwing", () => {
    expect(dividerLabel(Number.NaN, opts)).toBe("");
  });
});

describe("clockTime and fullDateTime", () => {
  const sent = sydney(2026, 10, 29, 18, 20, 11);

  it("gives the clock time alone", () => {
    expect(clockTime(sent, ZONE)).toBe("6:20 pm");
  });

  it("gives the whole date and the time", () => {
    expect(fullDateTime(sent, ZONE)).toBe("Thursday 29 October 2026 at 6:20 pm");
  });

  it("gives empty strings for a time it cannot read", () => {
    expect(clockTime(Number.NaN, ZONE)).toBe("");
    expect(fullDateTime(Number.POSITIVE_INFINITY, ZONE)).toBe("");
  });
});
