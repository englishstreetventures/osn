import { describe, it, expect } from "bun:test";

import {
  canonicalTimeZone,
  DEFAULT_RSVP_DEADLINE_TIMEZONE,
  isRsvpClosed,
  isValidTimeZone,
  resolveRsvpDeadline,
  rsvpDeadlineEndsAt,
} from "./rsvp-deadline";

describe("isValidTimeZone", () => {
  it("accepts real IANA identifiers", () => {
    for (const zone of ["UTC", "Australia/Sydney", "Asia/Kolkata", "America/New_York"]) {
      expect(isValidTimeZone(zone)).toBe(true);
    }
  });

  it("rejects anything the runtime cannot resolve", () => {
    for (const zone of ["", "Mars/Olympus_Mons", "GMT+11", "not a zone"]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });

  it("rejects fixed-offset zones that Intl would otherwise accept (S-L2)", () => {
    // These all construct an `Intl.DateTimeFormat` happily. An offset zone
    // never applies DST, so a deadline stored as one drifts an hour against the
    // organiser's real zone across a transition.
    for (const zone of ["+05:30", "-14:00", "+00:00"]) {
      expect(isValidTimeZone(zone)).toBe(false);
    }
  });
});

describe("canonicalTimeZone", () => {
  it("collapses casing and aliases to one spelling", () => {
    expect(canonicalTimeZone("AUSTRALIA/sydney")).toBe("Australia/Sydney");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Australia/Sydney")).toBe("Australia/Sydney");
  });

  it("returns null for offsets and for anything unresolvable", () => {
    for (const zone of ["+05:30", "-14:00", "Mars/Olympus_Mons", "GMT+11", ""]) {
      expect(canonicalTimeZone(zone)).toBeNull();
    }
  });

  it("never returns a value that differs from its own canonical form", () => {
    // The property the settings column relies on: canonicalising twice is the
    // same as canonicalising once, so a stored value is already settled.
    for (const zone of ["AUSTRALIA/sydney", "utc", "Asia/Kolkata"]) {
      const once = canonicalTimeZone(zone)!;
      expect(canonicalTimeZone(once)).toBe(once);
    }
  });
});

describe("rsvpDeadlineEndsAt", () => {
  it("ends the day at 23:59:59.999 UTC for UTC", () => {
    expect(new Date(rsvpDeadlineEndsAt("2026-09-01", "UTC")).toISOString()).toBe(
      "2026-09-01T23:59:59.999Z",
    );
  });

  it("shifts a whole-hour-ahead zone back by its offset", () => {
    // Sydney is UTC+10 in September (AEST), so the local day ends at 13:59:59.999Z.
    expect(new Date(rsvpDeadlineEndsAt("2026-09-01", "Australia/Sydney")).toISOString()).toBe(
      "2026-09-01T13:59:59.999Z",
    );
  });

  it("handles half-hour offsets", () => {
    // Kolkata is UTC+5:30 year-round.
    expect(new Date(rsvpDeadlineEndsAt("2026-09-01", "Asia/Kolkata")).toISOString()).toBe(
      "2026-09-01T18:29:59.999Z",
    );
  });

  it("handles zones behind UTC (the day ends on the NEXT UTC date)", () => {
    // New York is UTC-4 in September (EDT).
    expect(new Date(rsvpDeadlineEndsAt("2026-09-01", "America/New_York")).toISOString()).toBe(
      "2026-09-02T03:59:59.999Z",
    );
  });

  it("uses the offset in force ON the deadline day, not today's", () => {
    // The two-pass correction earns its keep here: Sydney is UTC+11 (AEDT) in
    // January and UTC+10 (AEST) in July, so a single pass sampled at the
    // UTC-interpreted instant could land on the wrong side of a transition.
    expect(new Date(rsvpDeadlineEndsAt("2026-01-15", "Australia/Sydney")).toISOString()).toBe(
      "2026-01-15T12:59:59.999Z",
    );
    expect(new Date(rsvpDeadlineEndsAt("2026-07-15", "Australia/Sydney")).toISOString()).toBe(
      "2026-07-15T13:59:59.999Z",
    );
  });

  it("resolves the end of a DST-transition day itself", () => {
    // 2026-04-05: Sydney falls back from AEDT (+11) to AEST (+10) at 03:00
    // local, so the day ENDS at +10 — 13:59:59.999Z, not 12:59:59.999Z.
    expect(new Date(rsvpDeadlineEndsAt("2026-04-05", "Australia/Sydney")).toISOString()).toBe(
      "2026-04-05T13:59:59.999Z",
    );
    // 2026-03-08: New York springs forward from EST (-5) to EDT (-4) at 02:00
    // local, so the day ends at -4 — 03:59:59.999Z on the 9th.
    expect(new Date(rsvpDeadlineEndsAt("2026-03-08", "America/New_York")).toISOString()).toBe(
      "2026-03-09T03:59:59.999Z",
    );
  });
});

describe("resolveRsvpDeadline", () => {
  const now = new Date("2026-09-01T12:00:00Z");

  it("returns null when no deadline is set", () => {
    expect(resolveRsvpDeadline(null, null, now)).toBeNull();
    expect(resolveRsvpDeadline(undefined, "Australia/Sydney", now)).toBeNull();
    expect(resolveRsvpDeadline("", null, now)).toBeNull();
  });

  it("falls back to UTC when the zone is missing or unknown", () => {
    expect(resolveRsvpDeadline("2026-09-01", null, now)?.timezone).toBe(
      DEFAULT_RSVP_DEADLINE_TIMEZONE,
    );
    expect(resolveRsvpDeadline("2026-09-01", "Mars/Olympus_Mons", now)?.timezone).toBe("UTC");
  });

  it("fails OPEN on a malformed or impossible stored date", () => {
    // A data problem must never lock guests out of an invite.
    expect(resolveRsvpDeadline("01/09/2026", "UTC", now)).toBeNull();
    expect(resolveRsvpDeadline("2026-9-1", "UTC", now)).toBeNull();
    expect(resolveRsvpDeadline("2026-02-31", "UTC", now)).toBeNull();
  });

  it("stays open for the whole of the deadline day", () => {
    const day = resolveRsvpDeadline("2026-09-01", "UTC", new Date("2026-09-01T23:59:59.999Z"));
    expect(day?.closed).toBe(false);
    expect(day?.closesAt).toBe("2026-09-01T23:59:59.999Z");
  });

  it("closes one millisecond later", () => {
    expect(
      resolveRsvpDeadline("2026-09-01", "UTC", new Date("2026-09-02T00:00:00.000Z"))?.closed,
    ).toBe(true);
  });

  it("measures the boundary in the stored zone, not the server's", () => {
    // 14:00Z on the 1st is already the 2nd in Sydney — closed there, open in UTC.
    const at = new Date("2026-09-01T14:00:00Z");
    expect(resolveRsvpDeadline("2026-09-01", "Australia/Sydney", at)?.closed).toBe(true);
    expect(resolveRsvpDeadline("2026-09-01", "UTC", at)?.closed).toBe(false);
  });

  it("echoes the stored date back unchanged", () => {
    expect(resolveRsvpDeadline("2026-09-01", "Australia/Sydney", now)?.date).toBe("2026-09-01");
  });
});

describe("isRsvpClosed", () => {
  it("is false when there is no deadline", () => {
    expect(isRsvpClosed(null, null, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("mirrors the resolved verdict", () => {
    expect(isRsvpClosed("2026-09-01", "UTC", new Date("2026-09-01T10:00:00Z"))).toBe(false);
    expect(isRsvpClosed("2026-09-01", "UTC", new Date("2026-09-05T10:00:00Z"))).toBe(true);
  });
});
