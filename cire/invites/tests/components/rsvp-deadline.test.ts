import { describe, it, expect } from "vitest";

import {
  deadlineNotice,
  formatDeadlineDay,
  isRsvpClosed,
} from "../../src/components/rsvp-deadline";
import type { RsvpDeadline } from "../../src/components/types";

const deadline = (over: Partial<RsvpDeadline> = {}): RsvpDeadline => ({
  date: "2026-09-01",
  timezone: "Australia/Sydney",
  closesAt: "2026-09-01T13:59:59.999Z",
  closed: false,
  ...over,
});

describe("isRsvpClosed", () => {
  it("is false when the wedding has no deadline", () => {
    expect(isRsvpClosed(null, new Date("2030-01-01T00:00:00Z"))).toBe(false);
    expect(isRsvpClosed(undefined, new Date("2030-01-01T00:00:00Z"))).toBe(false);
  });

  it("tracks the clock past closesAt, not the payload's snapshot", () => {
    // The whole point of shipping `closesAt`: a guest can hold a claimed invite
    // across the deadline, and `closed: false` was true when it was computed.
    const d = deadline({ closed: false });
    expect(isRsvpClosed(d, new Date("2026-09-01T13:59:59.999Z"))).toBe(false);
    expect(isRsvpClosed(d, new Date("2026-09-01T14:00:00.000Z"))).toBe(true);
  });

  it("falls back to the server's verdict when closesAt is unparseable", () => {
    expect(isRsvpClosed(deadline({ closesAt: "soon", closed: true }), new Date())).toBe(true);
    expect(isRsvpClosed(deadline({ closesAt: "soon", closed: false }), new Date())).toBe(false);
  });
});

describe("formatDeadlineDay", () => {
  it("renders the day in the WEDDING's zone, not the reader's", () => {
    // 2026-09-01 in Sydney. A UTC-rendered instant would be at risk of showing
    // 31 August to a guest reading from London.
    expect(formatDeadlineDay(deadline())).toBe("Tuesday 1 September 2026");
  });

  it("falls back to the raw date for an unknown zone", () => {
    expect(formatDeadlineDay(deadline({ timezone: "Mars/Olympus_Mons" }))).toBe("2026-09-01");
  });

  it("falls back to the raw date for a malformed one", () => {
    expect(formatDeadlineDay(deadline({ date: "not-a-date" }))).toBe("not-a-date");
  });
});

describe("deadlineNotice", () => {
  it("renders nothing when there is no deadline", () => {
    expect(deadlineNotice(null, false)).toBeNull();
  });

  it("invites a reply while the door is open", () => {
    expect(deadlineNotice(deadline(), false)).toBe("Kindly respond by Tuesday 1 September 2026.");
  });

  it("states the fact once it has shut", () => {
    expect(deadlineNotice(deadline(), true)).toBe("RSVPs closed on Tuesday 1 September 2026.");
  });
});
