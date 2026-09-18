import { describe, it, expect } from "vitest";

import {
  deadlineNotice,
  deadlineSummary,
  formatDeadlineDay,
  isRsvpClosed,
  rsvpDeadlineState,
  RSVP_SOON_WINDOW_DAYS,
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

describe("rsvpDeadlineState", () => {
  /** `closesAt` minus `days`, as the clock a guest would be reading at. */
  const daysBefore = (days: number) =>
    new Date(Date.parse("2026-09-01T13:59:59.999Z") - days * 86_400_000);

  it("is null only when the wedding has no deadline", () => {
    expect(rsvpDeadlineState(null, daysBefore(1))).toBeNull();
    expect(rsvpDeadlineState(undefined, daysBefore(1))).toBeNull();
  });

  it("reads open while the deadline is further off than the window", () => {
    expect(rsvpDeadlineState(deadline(), daysBefore(RSVP_SOON_WINDOW_DAYS + 1))).toBe("open");
  });

  it("reads closing-soon from the window's edge inwards", () => {
    // The edge itself is already inside the band: a guest exactly a week out is
    // in their final week, not a moment before it.
    expect(rsvpDeadlineState(deadline(), daysBefore(RSVP_SOON_WINDOW_DAYS))).toBe("closing-soon");
    expect(rsvpDeadlineState(deadline(), daysBefore(1))).toBe("closing-soon");
  });

  it("reads closed once the instant has passed", () => {
    expect(rsvpDeadlineState(deadline(), new Date("2026-09-01T14:00:00.000Z"))).toBe("closed");
  });

  it("reads open, never null, for an unparseable closesAt the server calls open", () => {
    // Nearness can't be measured from a broken instant, and a vanishing notice
    // beside locked buttons is the failure this guards.
    expect(rsvpDeadlineState(deadline({ closesAt: "soon", closed: false }), new Date())).toBe(
      "open",
    );
  });

  it("follows the server's verdict for an unparseable closesAt it calls closed", () => {
    expect(rsvpDeadlineState(deadline({ closesAt: "soon", closed: true }), new Date())).toBe(
      "closed",
    );
  });
});

describe("deadlineNotice", () => {
  it("renders nothing when there is no deadline", () => {
    expect(deadlineNotice(null, "open")).toBeNull();
    expect(deadlineNotice(deadline(), null)).toBeNull();
  });

  it("invites a reply while the door is open", () => {
    expect(deadlineNotice(deadline(), "open")).toBe("Kindly respond by Tuesday 1 September 2026.");
  });

  it("says the door is closing, in words and not only in colour", () => {
    expect(deadlineNotice(deadline(), "closing-soon")).toBe(
      "RSVPs close soon — kindly respond by Tuesday 1 September 2026.",
    );
  });

  it("states the fact once it has shut", () => {
    expect(deadlineNotice(deadline(), "closed")).toBe("RSVPs closed on Tuesday 1 September 2026.");
  });
});

describe("deadlineSummary", () => {
  it("renders nothing when there is no deadline", () => {
    expect(deadlineSummary(null, "open")).toBeNull();
    expect(deadlineSummary(deadline(), null)).toBeNull();
  });

  it("labels the date rather than repeating the notice's sentence", () => {
    expect(deadlineSummary(deadline(), "open")).toBe("RSVP by Tuesday 1 September 2026");
    expect(deadlineSummary(deadline(), "closing-soon")).toBe(
      "RSVP by Tuesday 1 September 2026 — closing soon",
    );
    expect(deadlineSummary(deadline(), "closed")).toBe("RSVPs closed on Tuesday 1 September 2026");
  });

  it("never repeats the notice verbatim, in any state", () => {
    // The two copies sit on one page. Printing one sentence twice reads as a
    // rendering fault; two statements of the same fact do not.
    for (const state of ["open", "closing-soon", "closed"] as const) {
      expect(deadlineSummary(deadline(), state)).not.toBe(deadlineNotice(deadline(), state));
    }
  });
});
