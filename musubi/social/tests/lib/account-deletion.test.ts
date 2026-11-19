import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localDay } from "../../src/lib/account-deletion";

// The window screen names the day the account is deleted on, in the reader's
// own zone. The account is never erased before the instant, and keeping it is
// refused from the instant on, so the day printed must be the one the instant
// falls on there: a day later would tell the reader they can keep the account
// for hours after they no longer can. Each case pins the zone, since the day
// depends on it.

const seconds = (iso: string) => Date.parse(iso) / 1_000;

let zone: string | undefined;
beforeEach(() => {
  zone = process.env.TZ;
});
afterEach(() => {
  if (zone === undefined) delete process.env.TZ;
  else process.env.TZ = zone;
});

describe("localDay", () => {
  it("names the day and no clock time", () => {
    process.env.TZ = "UTC";
    const { words } = localDay(seconds("2026-12-07T09:00:00Z"));
    expect(words).toContain("7");
    expect(words).toContain("2026");
    expect(words).not.toMatch(/\d:\d/);
    expect(words).not.toMatch(/AM|PM/);
  });

  it("gives a reader behind UTC the day before the UTC day, when the instant is early in UTC", () => {
    // 03:00 UTC on 7 December is 19:00 on 6 December in Los Angeles.
    process.env.TZ = "America/Los_Angeles";
    const day = localDay(seconds("2026-12-07T03:00:00Z"));
    expect(day.date).toBe("2026-12-06");
    expect(day.words).toContain("6");
    expect(day.words).toContain("Sunday");
  });

  it("gives a reader ahead of UTC the day after the UTC day, when the instant is late in UTC", () => {
    // 20:00 UTC on 6 December is 09:00 on 7 December in Auckland.
    process.env.TZ = "Pacific/Auckland";
    const day = localDay(seconds("2026-12-06T20:00:00Z"));
    expect(day.date).toBe("2026-12-07");
    expect(day.words).toContain("Monday");
  });

  it("puts an instant just after local midnight on that day, not the one before", () => {
    process.env.TZ = "Europe/London";
    const day = localDay(seconds("2026-12-07T00:01:00Z"));
    expect(day.date).toBe("2026-12-07");
    expect(day.words).toContain("Monday");
  });

  it("puts an instant just before local midnight on that day, not the one after", () => {
    // 23:59 in Tokyo is 14:59 UTC the same day.
    process.env.TZ = "Asia/Tokyo";
    const day = localDay(seconds("2026-12-07T14:59:00Z"));
    expect(day.date).toBe("2026-12-07");
    expect(day.words).toContain("Monday");
  });
});
