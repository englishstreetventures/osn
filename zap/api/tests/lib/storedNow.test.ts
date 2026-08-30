import { describe, expect, it, afterEach, vi } from "vitest";

import { storedNow } from "../../src/lib/storedNow";

describe("storedNow", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // Asserted against a frozen clock, not with `% 1000`. A modulo check only
  // says the milliseconds are zero, which a helper truncating to the hour — or
  // returning a fixed constant — also satisfies. Those failures are worse than
  // the one this exists to fix: a stale timestamp puts a `createdAt` cursor on
  // the wrong side of real messages, not 999ms out.
  it("truncates to the second the database actually stores", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-06-01T10:17:33.750Z"));
    expect(storedNow().toISOString()).toBe("2030-06-01T10:17:33.000Z");
  });

  it("leaves a timestamp already on a second boundary alone", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-06-01T10:17:33.000Z"));
    expect(storedNow().toISOString()).toBe("2030-06-01T10:17:33.000Z");
  });

  // Every fixture above is deliberately off the hour and off the minute. At
  // "10:00:00.750" a helper that floors to the second and one that floors to
  // the hour give the same answer, so the assertion would prove nothing about
  // which this is — an hour-truncating mutant passed the whole suite until
  // these moved to :17:33.
  it("truncates down, never up — a row must not claim a second it predates", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-06-01T10:17:33.999Z"));
    expect(storedNow().getTime()).toBe(new Date("2030-06-01T10:17:33.000Z").getTime());
  });
});
