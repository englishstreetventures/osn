import { describe, expect, it } from "vitest";

import { formatEventWhen } from "../../src/lib/event-display";

/**
 * The portal shows an event's time as a wall clock in its own zone, and never as
 * the UTC offset the stored timestamp carries — that offset is derived from the
 * zone (see `lib/timezones.ts`), so printing it next to the zone name states the
 * same fact twice, in a form the organiser can't edit. These pin that, including
 * on the degraded paths where the raw stored string used to leak through.
 */
describe("formatEventWhen", () => {
  it("renders start + end as local times in the event's zone", () => {
    expect(
      formatEventWhen("2026-11-14T15:00:00+11:00", "2026-11-14T17:00:00+11:00", "Australia/Sydney"),
    ).toBe("Sat, 14 Nov 2026 · 3:00 pm – 5:00 pm");
  });

  it("shows the LOCAL clock, whatever offset the stored instant was written with", () => {
    // Same instant, spelled as UTC. A Sydney organiser must still read 3 pm.
    expect(formatEventWhen("2026-11-14T04:00:00Z", "", "Australia/Sydney")).toBe(
      "Sat, 14 Nov 2026 · 3:00 pm",
    );
  });

  it("drops the range for the '' no-stated-end sentinel", () => {
    const out = formatEventWhen("2026-11-14T15:00:00+11:00", "", "Australia/Sydney");
    expect(out).toBe("Sat, 14 Nov 2026 · 3:00 pm");
    expect(out).not.toContain("–");
  });

  it("never prints the offset, in any zone", () => {
    for (const zone of ["Australia/Sydney", "Asia/Kolkata", "America/New_York", "UTC"]) {
      const out = formatEventWhen("2026-11-14T15:00:00+11:00", "", zone);
      expect(out).not.toMatch(/[+-]\d{2}:\d{2}/);
      expect(out).not.toContain("GMT");
    }
  });

  it("falls back to the wall clock — not the raw value — for an unresolvable zone", () => {
    // A spreadsheet import can carry a free-text zone this tz database doesn't
    // know. `Intl.DateTimeFormat` throws on it, and the old fallback printed the
    // stored string, offset and all.
    expect(formatEventWhen("2026-11-14T15:00:00+11:00", "", "Not/AZone")).toBe("2026-11-14 15:00");
    expect(
      formatEventWhen("2026-11-14T15:00:00+11:00", "2026-11-14T17:00:00+11:00", "Not/AZone"),
    ).toBe("2026-11-14 15:00 – 2026-11-14 17:00");
  });

  it("falls back for a half-filled draft (a date picked, no time yet)", () => {
    expect(formatEventWhen("2026-11-14", "", "Australia/Sydney")).toBe("2026-11-14");
  });

  it("shows a value that isn't a timestamp at all verbatim", () => {
    expect(formatEventWhen("TBD", "", "Australia/Sydney")).toBe("TBD");
  });

  it("drops a dangling dash when only the END is unparseable", () => {
    expect(formatEventWhen("2026-11-14T15:00:00+11:00", "not-a-date", "Australia/Sydney")).toBe(
      "Sat, 14 Nov 2026 · 3:00 pm",
    );
  });
});
