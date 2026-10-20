import { describe, it, expect } from "vitest";

import {
  formatEventDay,
  formatTimeRange,
  guestLocalTime,
  invitedNames,
  resolveMapsEmbedUrl,
  resolveMapsUrl,
  timezoneLabel,
  timezoneName,
  venueLine,
} from "../../src/components/event-details";
import type { EventSummary, FamilyMember } from "../../src/components/types";

const base: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Strathfield",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

describe("venueLine", () => {
  it("returns the canonical address", () => {
    expect(venueLine(base)).toBe("12 Banksia Lane, Strathfield");
  });

  it("returns null when the address is absent or blank", () => {
    expect(venueLine({ address: null })).toBeNull();
    expect(venueLine({ address: "   " })).toBeNull();
  });
});

describe("formatEventDay", () => {
  it("formats the wall-clock day in the event timezone", () => {
    const out = formatEventDay(base);
    expect(out).toContain("Friday");
    expect(out).toContain("18 September 2026");
  });

  it("does not roll back across the UTC date boundary", () => {
    // 11pm Sydney on the 18th is still the 18th locally even though it is the
    // 18th 13:00 UTC — guard the off-by-one a naive UTC formatter would hit.
    const late = { ...base, startAt: "2026-09-18T23:00:00+10:00" };
    expect(formatEventDay(late)).toContain("18 September 2026");
  });

  it("returns an empty string for an unparseable instant", () => {
    expect(formatEventDay({ ...base, startAt: "not-a-date" })).toBe("");
  });
});

describe("formatTimeRange", () => {
  it("renders a start–end range in the event timezone", () => {
    const out = formatTimeRange(base);
    expect(out).toMatch(/4:00\s*pm/i);
    expect(out).toMatch(/10:00\s*pm/i);
    expect(out).toContain("–");
  });

  it("collapses to a single time when start and end coincide", () => {
    const point = { ...base, endAt: base.startAt };
    const out = formatTimeRange(point);
    expect(out).toMatch(/4:00\s*pm/i);
    expect(out).not.toContain("–");
  });

  it("shows just the start for the '' no-stated-end sentinel (End optional in the sheet)", () => {
    const out = formatTimeRange({ ...base, endAt: "" });
    expect(out).toMatch(/4:00\s*pm/i);
    expect(out).not.toContain("–");
    expect(out).not.toContain("Invalid");
  });
});

describe("formatTimeRange across days", () => {
  it("names both days for an overnight event that ends the next morning (F1)", () => {
    const night = {
      ...base,
      startAt: "2026-11-14T20:00:00+11:00",
      endAt: "2026-11-15T02:00:00+11:00",
    };
    expect(formatTimeRange(night)).toBe("Sat 8:00 pm – Sun 2:00 am");
  });

  it("names both days for a weekend-long event (F2)", () => {
    const weekend = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-15T11:00:00+11:00",
    };
    expect(formatTimeRange(weekend)).toBe("Fri 6:00 pm – Sun 11:00 am");
  });

  it("reads the days in the event's own zone, not in UTC (F3)", () => {
    // 5:30 pm – 11:30 pm in Sydney is 06:30 → 12:30 UTC: one day there, one
    // day here. And 9 am – 11:30 am in Sydney straddles midnight UTC.
    const evening = {
      ...base,
      startAt: "2026-11-14T17:30:00+11:00",
      endAt: "2026-11-14T23:30:00+11:00",
    };
    expect(formatTimeRange(evening)).toBe("5:30 pm – 11:30 pm");
    const morning = {
      ...base,
      startAt: "2026-11-14T09:00:00+11:00",
      endAt: "2026-11-14T11:30:00+11:00",
    };
    expect(formatTimeRange(morning)).toBe("9:00 am – 11:30 am");
    // And an event that is one day in UTC but two in its own zone.
    const late = {
      ...base,
      startAt: "2026-11-14T22:00:00+11:00",
      endAt: "2026-11-15T01:00:00+11:00",
    };
    expect(formatTimeRange(late)).toBe("Sat 10:00 pm – Sun 1:00 am");
  });

  it("keeps an event with no stated end end-less, on any day (F4)", () => {
    expect(formatTimeRange({ ...base, endAt: "" })).toBe("4:00 pm");
    expect(formatTimeRange({ ...base, endAt: "" }, base.timezone, { startDay: true })).toBe(
      "Fri 4:00 pm",
    );
  });

  it("dates both ends once they are a week or more apart (F5)", () => {
    const week = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-21T11:00:00+11:00",
    };
    expect(formatTimeRange(week)).toBe("Fri, 13 Nov 6:00 pm – Sat, 21 Nov 11:00 am");
    // Exactly a week: "Fri – Fri" would name one day twice.
    const sevenDays = { ...week, endAt: "2026-11-20T11:00:00+11:00" };
    expect(formatTimeRange(sevenDays)).toBe("Fri, 13 Nov 6:00 pm – Fri, 20 Nov 11:00 am");
    const sixDays = { ...week, endAt: "2026-11-19T11:00:00+11:00" };
    expect(formatTimeRange(sixDays)).toBe("Fri 6:00 pm – Thu 11:00 am");
  });

  it("gives one time for a zero-length event, and both days for one exactly a day long (F6)", () => {
    expect(formatTimeRange({ ...base, endAt: base.startAt })).toBe("4:00 pm");
    const day = { ...base, endAt: "2026-09-19T16:00:00+10:00" };
    expect(formatTimeRange(day)).toBe("Fri 4:00 pm – Sat 4:00 pm");
  });
});

describe("timezoneName", () => {
  it("spells the zone out with the place it is named after (F7)", () => {
    const sydney = { startAt: "2026-11-14T17:30:00+11:00", timezone: "Australia/Sydney" };
    expect(timezoneName(sydney)).toBe("AEDT (Sydney time)");
    expect(timezoneName({ ...sydney, timezone: "America/Argentina/Buenos_Aires" })).toBe(
      "GMT-3 (Buenos Aires time)",
    );
    expect(timezoneName({ ...sydney, timezone: "UTC" })).toBe("UTC");
    expect(timezoneName({ ...sydney, timezone: "Etc/GMT-10" })).toBe("GMT+10");
    expect(timezoneName({ ...sydney, startAt: "not-a-date" })).toBe("");
  });
});

describe("guestLocalTime", () => {
  const sangeet = {
    ...base,
    startAt: "2026-11-14T17:30:00+11:00",
    endAt: "2026-11-14T23:30:00+11:00",
  };

  it("says nothing when the guest's clock reads the same as the event's (F8)", () => {
    expect(guestLocalTime(sangeet, "Australia/Sydney")).toBeNull();
    expect(guestLocalTime(sangeet, "Australia/Melbourne")).toBeNull();
  });

  it("gives the guest's own times, with their day, when it differs (F9)", () => {
    expect(guestLocalTime(sangeet, "Europe/London")).toBe("Sat 6:30 am – 12:30 pm (GMT)");
    expect(guestLocalTime(sangeet, "America/Los_Angeles")).toBe(
      "Fri 10:30 pm – Sat 4:30 am (GMT-8)",
    );
  });

  it("gives nothing for a zone the browser does not know, or an unreadable start (F10)", () => {
    expect(guestLocalTime(sangeet, "Not/AZone")).toBeNull();
    expect(guestLocalTime({ ...sangeet, startAt: "" }, "Europe/London")).toBeNull();
  });
});

describe("invitedNames", () => {
  const member = (firstName: string, eventIds: string[], extra: Partial<FamilyMember> = {}) => ({
    guestId: `g-${firstName}`,
    firstName,
    lastName: "Sharma",
    nickname: null,
    eventIds,
    ...extra,
  });

  it("says nothing when everyone the couple invited is invited (F11)", () => {
    const alex = member("Alex", ["e1"]);
    const sam = member("Sam", ["e1"]);
    // A plus-one is never what makes the list show.
    const jo = member("Jo", [], { plusOneOf: "g-Sam" });
    expect(invitedNames([alex, sam, jo], "e1")).toBeNull();
    expect(invitedNames([alex], "e1")).toBeNull();
    expect(invitedNames([], "e1")).toBeNull();
  });

  it("names exactly who is invited, a plus-one included (F12)", () => {
    const alex = member("Alex", ["e1", "e2"]);
    const sam = member("Sam", ["e1"]);
    const jo = member("Jo", ["e1"], { plusOneOf: "g-Sam" });
    const priya = member("Priya", ["e2"]);
    expect(invitedNames([alex, sam, jo, priya], "e1")).toBe("Alex, Sam and Jo");
    expect(invitedNames([alex, sam, jo, priya], "e2")).toBe("Alex and Priya");
  });

  it("tells two people with one first name apart (F13)", () => {
    const sam = member("Sam", ["e1"]);
    const samK = member("Sam", ["e1"], { lastName: "Kaur" });
    const priya = member("Priya", []);
    expect(invitedNames([sam, samK, priya], "e1")).toBe("Sam Sharma and Sam Kaur");
    // Names as stored can carry stray spaces; " Sam " is still Sam, and a
    // missing last name leaves no dangling space.
    const padded = member(" Sam ", ["e1"], { lastName: " Kaur " });
    const bare = member("Sam", ["e1"], { lastName: "" });
    expect(invitedNames([padded, bare, priya], "e1")).toBe("Sam Kaur and Sam");
    // The Sam who is asked is told apart from a Sam who is not: the household
    // reads the line, and both Sams are in it.
    const samAway = member("Sam", [], { lastName: "Kaur" });
    const priyaHere = member("Priya", ["e1"]);
    expect(invitedNames([sam, samAway, priyaHere], "e1")).toBe("Sam Sharma and Priya");
  });

  it("gives nothing rather than an empty list when nobody is invited (F14)", () => {
    expect(invitedNames([member("Alex", ["e2"])], "e1")).toBeNull();
  });
});

describe("timezoneLabel", () => {
  it("returns a short zone label for the instant", () => {
    expect(timezoneLabel(base)).toMatch(/GMT\+10|AE[SD]T/);
  });
});

describe("resolveMapsUrl", () => {
  it("uses a valid organiser-supplied mapsUrl verbatim", () => {
    const url = "https://maps.apple.com/?address=12+Banksia+Lane";
    expect(resolveMapsUrl({ ...base, mapsUrl: url })).toBe(url);
  });

  it("ignores a non-http mapsUrl and derives from the address", () => {
    const out = resolveMapsUrl({ ...base, mapsUrl: "javascript:alert(1)" });
    expect(out).toContain("https://www.google.com/maps/search/");
    expect(out).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
  });

  it("derives a search URL from the address when mapsUrl is null", () => {
    const out = resolveMapsUrl(base);
    expect(out).toContain("https://www.google.com/maps/search/?api=1&query=");
    expect(out).toContain(encodeURIComponent("12 Banksia Lane, Strathfield"));
  });

  it("returns null when there is nothing to point at", () => {
    expect(resolveMapsUrl({ mapsUrl: null, address: null })).toBeNull();
  });
});

describe("resolveMapsEmbedUrl", () => {
  const KEY = "test-embed-key";

  it("builds a Maps Embed place URL with an encoded address query", () => {
    const out = resolveMapsEmbedUrl(base, KEY);
    expect(out).toContain("https://www.google.com/maps/embed/v1/place?");
    expect(out).toContain(`key=${encodeURIComponent(KEY)}`);
    expect(out).toContain(`q=${encodeURIComponent("12 Banksia Lane, Strathfield")}`);
  });

  it("returns null when the address is absent", () => {
    expect(resolveMapsEmbedUrl({ ...base, address: null }, KEY)).toBeNull();
  });

  it("returns null when no key is configured", () => {
    expect(resolveMapsEmbedUrl(base, undefined)).toBeNull();
    expect(resolveMapsEmbedUrl(base, "")).toBeNull();
    expect(resolveMapsEmbedUrl(base, "   ")).toBeNull();
  });

  it("returns null when there is no venue address to query", () => {
    expect(resolveMapsEmbedUrl({ ...base, address: null }, KEY)).toBeNull();
  });

  it("encodes special characters in the address so they cannot break the query", () => {
    const out = resolveMapsEmbedUrl({ ...base, address: "Café & Co, 1 A&B St #2" }, KEY);
    expect(out).toContain(`q=${encodeURIComponent("Café & Co, 1 A&B St #2")}`);
    // The raw ampersand must not appear unescaped in the query segment.
    expect(out?.split("&q=")[1]).not.toContain("&");
  });
});
