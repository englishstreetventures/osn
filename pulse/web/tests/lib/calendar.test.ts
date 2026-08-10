import { describe, expect, it } from "vitest";

import {
  formatDayLabel,
  formatRailDate,
  formatTimeRange,
  groupEntriesByDay,
  type CalendarEntry,
} from "../../src/lib/calendar";

// Build a minimal CalendarEntry for a given local start (and optional end).
function entry(title: string, start: Date, end: Date | null = null): CalendarEntry {
  return {
    event: {
      id: `evt_${title}`,
      title,
      description: null,
      location: null,
      venue: null,
      category: null,
      startTime: start.toISOString(),
      endTime: end ? end.toISOString() : null,
      status: "upcoming",
      imageUrl: null,
      createdByProfileId: "usr_x",
      createdByName: null,
      createdByAvatar: null,
    },
    myStatus: "going",
    isHost: false,
  };
}

describe("groupEntriesByDay", () => {
  it("buckets same-day entries together and keeps separate days apart", () => {
    const entries = [
      entry("morning", new Date(2026, 4, 28, 9, 0)),
      entry("evening", new Date(2026, 4, 28, 19, 0)),
      entry("next-day", new Date(2026, 4, 29, 12, 0)),
    ];
    const groups = groupEntriesByDay(entries, new Date(2026, 4, 28, 8, 0));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.entries.map((e) => e.event.title)).toEqual(["morning", "evening"]);
    expect(groups[1]!.entries.map((e) => e.event.title)).toEqual(["next-day"]);
  });

  it("labels the first two days Today and Tomorrow", () => {
    const nowDate = new Date(2026, 4, 28, 8, 0);
    const groups = groupEntriesByDay(
      [entry("a", new Date(2026, 4, 28, 9, 0)), entry("b", new Date(2026, 4, 29, 9, 0))],
      nowDate,
    );
    expect(groups[0]!.label).toBe("Today");
    expect(groups[1]!.label).toBe("Tomorrow");
  });
});

describe("formatDayLabel", () => {
  const now = new Date(2026, 4, 28, 8, 0);
  it("returns Today / Tomorrow for the next two days", () => {
    expect(formatDayLabel(new Date(2026, 4, 28, 20, 0), now)).toBe("Today");
    expect(formatDayLabel(new Date(2026, 4, 29, 6, 0), now)).toBe("Tomorrow");
  });
});

describe("formatTimeRange", () => {
  it("formats a start-only time", () => {
    expect(formatTimeRange(new Date(2026, 4, 28, 19, 0).toISOString(), null)).toBe("7 PM");
  });
  it("formats a start–end range with minutes", () => {
    expect(
      formatTimeRange(
        new Date(2026, 4, 28, 19, 30).toISOString(),
        new Date(2026, 4, 28, 21, 0).toISOString(),
      ),
    ).toBe("7:30 PM – 9 PM");
  });
});

describe("formatRailDate", () => {
  it("returns uppercase month, day number, and weekday", () => {
    const parts = formatRailDate(new Date(2026, 4, 28));
    expect(parts.month).toBe("MAY");
    expect(parts.day).toBe(28);
    expect(parts.weekday).toBe("THU");
  });
});
