import { describe, expect, it, vi } from "vitest";

import {
  afterMidnight,
  childrenPolicyOf,
  clockLabel,
  guestOrder,
  isClockTime,
  plusOnePolicyOf,
  startMinutes,
} from "../../src/lib/event-guest-details";

// What the drawer and the events list make of an event's run of show and
// guest policy: the words a time is read as, the preset a select's value is
// read back as, and which items a guest reads as after midnight.

describe("clockLabel", () => {
  it("reads a 24-hour time on a 12-hour clock, as the guest's sheet does", () => {
    expect(clockLabel("00:30")).toBe("12:30 am");
    expect(clockLabel("09:05")).toBe("9:05 am");
    expect(clockLabel("11:59")).toBe("11:59 am");
    expect(clockLabel("12:00")).toBe("12:00 pm");
    expect(clockLabel("16:45")).toBe("4:45 pm");
  });
});

describe("isClockTime", () => {
  it("takes exactly HH:MM on a 24-hour clock", () => {
    for (const time of ["00:00", "09:05", "23:59"]) expect(isClockTime(time)).toBe(true);
    for (const time of ["", "4pm", "6:00", "24:00", "16:60", "x16:00", "16:000"]) {
      expect(isClockTime(time)).toBe(false);
    }
  });
});

describe("the policy selects", () => {
  it("read the empty choice and anything unknown as not stated", () => {
    for (const value of ["", "kids_ok"]) {
      expect(childrenPolicyOf(value)).toBeNull();
      expect(plusOnePolicyOf(value)).toBeNull();
    }
  });

  it("read each preset as itself", () => {
    expect(childrenPolicyOf("adults_only")).toBe("adults_only");
    expect(childrenPolicyOf("children_welcome")).toBe("children_welcome");
    expect(plusOnePolicyOf("by_invitation")).toBe("by_invitation");
    expect(plusOnePolicyOf("welcome")).toBe("welcome");
    expect(childrenPolicyOf("welcome")).toBeNull();
    expect(plusOnePolicyOf("adults_only")).toBeNull();
  });
});

describe("afterMidnight", () => {
  // 4:00 pm in Sydney, stored with its offset as the drawer stamps it.
  const START = "2026-11-20T16:00:00+11:00";
  const SYDNEY = "Australia/Sydney";

  it("marks a time earlier than the start on the event's own clock", () => {
    expect(afterMidnight("00:30", START, SYDNEY)).toBe(true);
    expect(afterMidnight("15:59", START, SYDNEY)).toBe(true);
    expect(afterMidnight("16:00", START, SYDNEY)).toBe(false);
    expect(afterMidnight("23:30", START, SYDNEY)).toBe(false);
  });

  it("reads the start in the event's zone, not the stored offset's", () => {
    // The same instant is 5:00 am UTC, so in London nothing after 5 am is
    // after midnight.
    expect(afterMidnight("04:59", START, "Europe/London")).toBe(true);
    expect(afterMidnight("06:00", START, "Europe/London")).toBe(false);
  });

  it("counts the minutes of the start and of the item", () => {
    const halfPast = "2026-11-20T16:30:00+11:00";
    expect(afterMidnight("16:10", halfPast, SYDNEY)).toBe(true);
    expect(afterMidnight("16:45", halfPast, SYDNEY)).toBe(false);
    expect(afterMidnight("16:10", halfPast, "Not/AZone")).toBe(true);
    expect(afterMidnight("16:45", halfPast, "Not/AZone")).toBe(false);
  });

  it("reads the stored clock when the zone does not resolve", () => {
    expect(afterMidnight("15:00", START, "Not/AZone")).toBe(true);
    expect(afterMidnight("17:00", START, "Not/AZone")).toBe(false);
  });

  it("marks nothing for a time not yet set or a start it cannot read", () => {
    expect(afterMidnight("", START, SYDNEY)).toBe(false);
    expect(afterMidnight("00:30", "", SYDNEY)).toBe(false);
    expect(afterMidnight("00:30", "not a date", SYDNEY)).toBe(false);
    // A start date with its time not filled in yet is no time to count from.
    expect(afterMidnight("09:00", "2026-11-20", SYDNEY)).toBe(false);
    expect(afterMidnight("09:00", "2026-11-20", "America/Los_Angeles")).toBe(false);
  });

  // A drawer of 40 items reads the start for every row on every render: the
  // zone's clock is built once, not once a row.
  it("builds the zone's clock once, however often the start is read", () => {
    const zone = "Pacific/Chatham";
    const built = vi.spyOn(Intl, "DateTimeFormat");
    try {
      for (let i = 0; i < 40; i += 1) startMinutes("2026-11-20T16:00:00+13:45", zone);
      expect(built.mock.calls.filter(([, options]) => options?.timeZone === zone)).toHaveLength(1);
    } finally {
      built.mockRestore();
    }
  });
});

describe("guestOrder", () => {
  const START = "2026-11-14T18:00:00+11:00";
  const SYDNEY = "Australia/Sydney";
  const order = (items: { time: string; label: string }[], startAt = START) =>
    guestOrder(items, startAt, SYDNEY).map(
      (l) => `${l.time} ${l.label}${l.afterMidnight ? " (after midnight)" : ""}`,
    );

  it("reads the list by time from the start, an item after midnight last and marked", () => {
    expect(
      order([
        { time: "21:00", label: "Speeches" },
        { time: "00:30", label: "Carriages" },
        { time: "18:00", label: "Canapés" },
      ]),
    ).toEqual(["18:00 Canapés", "21:00 Speeches", "00:30 Carriages (after midnight)"]);
  });

  it("keeps the organiser's order at the same time, and leaves out what a guest is not shown", () => {
    expect(
      order([
        { time: "19:00", label: "Entrées" },
        { time: "", label: "Unset" },
        { time: "19:00", label: " Wine " },
        { time: "18:30", label: "   " },
      ]),
    ).toEqual(["19:00 Entrées", "19:00 Wine"]);
  });

  it("uses plain clock order with no start to read", () => {
    expect(
      order(
        [
          { time: "12:00", label: "Lunch" },
          { time: "08:00", label: "Breakfast" },
        ],
        "",
      ),
    ).toEqual(["08:00 Breakfast", "12:00 Lunch"]);
  });
});
