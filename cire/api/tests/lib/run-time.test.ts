import { describe, expect, it } from "bun:test";

import { formatInstantInZone } from "../../src/lib/event-time";
import {
  anchoredRunAt,
  clockOffsetMinutes,
  deriveRunTime,
  isRunOffsetInRange,
  MAX_RUN_OFFSET_MINUTES,
  type EventTime,
  type RunTimeColumns,
} from "../../src/lib/run-time";

/**
 * A linked task's time is its event's start moved by an offset in REAL elapsed
 * minutes, read on the event's own clock. The cases that tell that apart from
 * adding minutes to the wall clock are the two Sydney transitions in 2099:
 * Sunday 4 October, when 02:00 AEST becomes 03:00 AEDT (an hour that never
 * happens), and Sunday 5 April, when 03:00 AEDT becomes 02:00 AEST (an hour
 * that happens twice).
 */
const SYDNEY = "Australia/Sydney";
/** 01:30 on the morning the clocks go forward. */
const BEFORE_GAP = "2099-10-04T01:30:00+10:00";
/** 01:30 on the morning the clocks go back. */
const BEFORE_REPEAT = "2099-04-05T01:30:00+11:00";

describe("formatInstantInZone", () => {
  it("reads an instant on the zone's clock, with the offset that instant has", () => {
    expect(formatInstantInZone(Date.parse("2099-06-20T05:00:00Z"), SYDNEY)).toBe(
      "2099-06-20T15:00:00+10:00",
    );
    expect(formatInstantInZone(Date.parse("2099-12-20T04:00:00Z"), SYDNEY)).toBe(
      "2099-12-20T15:00:00+11:00",
    );
    expect(formatInstantInZone(Date.parse("2099-06-20T09:30:00Z"), "Asia/Kolkata")).toBe(
      "2099-06-20T15:00:00+05:30",
    );
    expect(formatInstantInZone(Date.parse("2099-06-20T09:30:00Z"), "Europe/London")).toBe(
      "2099-06-20T10:30:00+01:00",
    );
  });

  it("answers null for a zone that is not a real IANA zone", () => {
    expect(formatInstantInZone(0, "Mars/Base")).toBeNull();
    expect(formatInstantInZone(0, "+10:00")).toBeNull();
  });
});

describe("anchoredRunAt: elapsed time, on the event's clock", () => {
  it("lands an hour after 01:30 at 03:30 on the morning the clocks go forward", () => {
    expect(anchoredRunAt(BEFORE_GAP, SYDNEY, 60)).toBe("2099-10-04T03:30:00+11:00");
    // Half an hour after: the instant 02:00 AEST is 03:00 AEDT.
    expect(anchoredRunAt(BEFORE_GAP, SYDNEY, 30)).toBe("2099-10-04T03:00:00+11:00");
  });

  it("counts back across the gap the same way", () => {
    expect(anchoredRunAt("2099-10-04T03:30:00+11:00", SYDNEY, -60)).toBe(
      "2099-10-04T01:30:00+10:00",
    );
  });

  it("passes through the repeated hour twice on the morning the clocks go back", () => {
    expect(anchoredRunAt(BEFORE_REPEAT, SYDNEY, 60)).toBe("2099-04-05T02:30:00+11:00");
    expect(anchoredRunAt(BEFORE_REPEAT, SYDNEY, 120)).toBe("2099-04-05T02:30:00+10:00");
    expect(anchoredRunAt("2099-04-05T02:30:00+10:00", SYDNEY, -120)).toBe(BEFORE_REPEAT);
  });

  it("reads the time in the event's zone, never the runner's or UTC", () => {
    expect(anchoredRunAt("2099-06-20T15:00:00+05:30", "Asia/Kolkata", -45)).toBe(
      "2099-06-20T14:15:00+05:30",
    );
  });

  it("answers null when the start cannot be read or the zone is not real", () => {
    expect(anchoredRunAt("not a time", SYDNEY, 0)).toBeNull();
    expect(anchoredRunAt(BEFORE_GAP, "Mars/Base", 0)).toBeNull();
  });
});

describe("clockOffsetMinutes: a clock time typed against an event", () => {
  it("counts real minutes from the start across the gap", () => {
    expect(clockOffsetMinutes(BEFORE_GAP, SYDNEY, "2099-10-04T03:30")).toBe(60);
  });

  it("moves a clock reading inside the gap forward, as an event's own time is", () => {
    // 02:30 never happens that morning: it is read as 03:30 AEDT.
    expect(clockOffsetMinutes(BEFORE_GAP, SYDNEY, "2099-10-04T02:30")).toBe(60);
  });

  it("reads a clock reading inside the repeated hour as its second occurrence", () => {
    expect(clockOffsetMinutes(BEFORE_REPEAT, SYDNEY, "2099-04-05T02:30")).toBe(120);
  });

  it("ignores an offset typed into the clock reading", () => {
    expect(clockOffsetMinutes("2099-06-20T15:00:00+10:00", SYDNEY, "2099-06-20T14:30+05:30")).toBe(
      -30,
    );
  });

  it("answers null when the reading, the start or the zone cannot be read", () => {
    expect(clockOffsetMinutes(BEFORE_GAP, SYDNEY, "tomorrow")).toBeNull();
    expect(clockOffsetMinutes("nope", SYDNEY, "2099-10-04T03:30")).toBeNull();
    expect(clockOffsetMinutes(BEFORE_GAP, "Mars/Base", "2099-10-04T03:30")).toBeNull();
  });
});

describe("isRunOffsetInRange", () => {
  it("holds a link to a day either side of the start", () => {
    expect(MAX_RUN_OFFSET_MINUTES).toBe(1440);
    expect(isRunOffsetInRange(-1440)).toBe(true);
    expect(isRunOffsetInRange(1440)).toBe(true);
    expect(isRunOffsetInRange(0)).toBe(true);
    expect(isRunOffsetInRange(1441)).toBe(false);
    expect(isRunOffsetInRange(-1441)).toBe(false);
    expect(isRunOffsetInRange(0.5)).toBe(false);
    expect(isRunOffsetInRange(Number.NaN)).toBe(false);
  });

  it("is what a clock time a day and a minute away fails", () => {
    const offset = clockOffsetMinutes("2099-06-20T15:00:00+10:00", SYDNEY, "2099-06-21T15:01");
    expect(offset).toBe(1441);
    expect(isRunOffsetInRange(offset!)).toBe(false);
  });
});

describe("deriveRunTime", () => {
  const none: RunTimeColumns = {
    runAt: null,
    runTimezone: null,
    eventId: null,
    runOffsetMinutes: null,
    eventRemovedAt: null,
  };
  const ceremony: EventTime = { startAt: "2099-06-20T15:00:00+10:00", timezone: SYDNEY };
  const events = new Map([["evt_ceremony", ceremony]]);

  it("leaves an untimed task untimed", () => {
    expect(deriveRunTime(none, events)).toEqual({
      runAt: null,
      runTimezone: null,
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
    });
  });

  it("answers a fixed time as stored", () => {
    const fixed = {
      ...none,
      runAt: "2099-06-20T12:00:00+05:30",
      runTimezone: "Asia/Calcutta",
    };
    expect(deriveRunTime(fixed, events)).toEqual({
      runAt: "2099-06-20T12:00:00+05:30",
      runTimezone: "Asia/Calcutta",
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
    });
  });

  it("derives a linked task's time from its event, in the event's zone", () => {
    const linked = { ...none, eventId: "evt_ceremony", runOffsetMinutes: -30 };
    expect(deriveRunTime(linked, events)).toEqual({
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: SYDNEY,
      eventId: "evt_ceremony",
      runOffsetMinutes: -30,
      anchored: true,
      eventRemoved: false,
    });
  });

  it("follows the event when it moves", () => {
    const linked = { ...none, eventId: "evt_ceremony", runOffsetMinutes: -30 };
    const moved = new Map([
      ["evt_ceremony", { startAt: "2099-06-21T09:00:00+05:30", timezone: "Asia/Kolkata" }],
    ]);
    expect(deriveRunTime(linked, moved).runAt).toBe("2099-06-21T08:30:00+05:30");
    expect(deriveRunTime(linked, moved).runTimezone).toBe("Asia/Kolkata");
  });

  it("reads a link to an event it was not given — another wedding's, or one gone — as untimed", () => {
    const stray = { ...none, eventId: "evt_elsewhere", runOffsetMinutes: -30 };
    expect(deriveRunTime(stray, events)).toEqual({
      runAt: null,
      runTimezone: null,
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: false,
    });
  });

  it("keeps a linked task linked but untimed when its event's start cannot be read", () => {
    const linked = { ...none, eventId: "evt_ceremony", runOffsetMinutes: 10 };
    const broken = new Map([["evt_ceremony", { startAt: "TBC", timezone: SYDNEY }]]);
    expect(deriveRunTime(linked, broken)).toMatchObject({
      runAt: null,
      eventId: "evt_ceremony",
      anchored: true,
    });
  });

  it("marks a task whose event a schedule change removed, keeping its last time", () => {
    const frozen = {
      ...none,
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: SYDNEY,
      eventRemovedAt: new Date(1),
    };
    expect(deriveRunTime(frozen, events)).toEqual({
      runAt: "2099-06-20T14:30:00+10:00",
      runTimezone: SYDNEY,
      eventId: null,
      runOffsetMinutes: null,
      anchored: false,
      eventRemoved: true,
    });
  });
});
