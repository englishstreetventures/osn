import { describe, it, expect } from "vitest";

import {
  formatEventDay,
  formatTimeRange,
  guestLocalTime,
  guestTimeZone,
  invitedNames,
  resolveMapsEmbedUrl,
  resolveMapsUrl,
  timezoneLabel,
  timezoneName,
  venueLine,
} from "../../src/components/event-details";
import type { EventSummary, FamilyMember } from "../../src/components/types";

/** Intl puts a narrow no-break space before "pm"; compare on plain spaces. */
const plain = (s: string | null) => (s ?? "").replaceAll(/[\u202f\u00a0]/g, " ");

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
  it("names both days for an event that runs past midnight", () => {
    // Read as one evening, "8:00 pm – 1:00 am" hides that it ends the next day.
    const overnight = {
      ...base,
      startAt: "2026-09-18T20:00:00+10:00",
      endAt: "2026-09-19T01:00:00+10:00",
    };
    expect(plain(formatTimeRange(overnight))).toBe("Fri 8:00 pm – Sat 1:00 am");
  });

  it("names both days for a weekend event", () => {
    // Friday 6 pm to Sunday 11 am: a weekend away.
    const weekend = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-15T11:00:00+11:00",
    };
    expect(plain(formatTimeRange(weekend))).toBe("Fri 6:00 pm – Sun 11:00 am");
  });

  it("compares calendar days in the event's zone, not the machine's or UTC", () => {
    // 9 am–11 pm in Sydney is one day there, but crosses midnight in UTC
    // (23:00–13:00) — a UTC comparison would call it two days.
    const long = {
      ...base,
      startAt: "2026-09-18T09:00:00+10:00",
      endAt: "2026-09-18T23:00:00+10:00",
    };
    expect(plain(formatTimeRange(long))).toBe("9:00 am – 11:00 pm");
  });

  it("formats in a zone it is given rather than the event's", () => {
    // The same instants seen from Perth, three hours behind Sydney in summer.
    const weekend = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-15T11:00:00+11:00",
    };
    expect(plain(formatTimeRange(weekend, "Australia/Perth"))).toBe("Fri 3:00 pm – Sun 8:00 am");
  });

  it("keeps a missing end missing", () => {
    expect(plain(formatTimeRange({ ...base, endAt: "" }))).toBe("4:00 pm");
  });

  it("dates both ends of a span of a week or more", () => {
    // "Fri – Sat" a week apart reads as the next day.
    const long = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-21T11:00:00+11:00",
    };
    expect(plain(formatTimeRange(long))).toBe("Fri 13 Nov 6:00 pm – Sat 21 Nov 11:00 am");
  });

  it("dates both ends of a span of exactly a week", () => {
    // Friday to Friday: two weekdays the same would read as one day.
    const week = {
      ...base,
      startAt: "2026-11-13T18:00:00+11:00",
      endAt: "2026-11-20T11:00:00+11:00",
    };
    expect(plain(formatTimeRange(week))).toBe("Fri 13 Nov 6:00 pm – Fri 20 Nov 11:00 am");
  });

  it("prints one time, not 'x – x', when the clocks match on one day", () => {
    expect(plain(formatTimeRange({ ...base, endAt: base.startAt }))).toBe("4:00 pm");
  });

  it("still names both days when the clocks match a day apart", () => {
    const day = {
      ...base,
      startAt: "2026-09-18T16:00:00+10:00",
      endAt: "2026-09-19T16:00:00+10:00",
    };
    expect(plain(formatTimeRange(day))).toBe("Fri 4:00 pm – Sat 4:00 pm");
  });
});

describe("timezoneName", () => {
  it("spells out the city beside the short label", () => {
    expect(timezoneName(base)).toMatch(/^(AEST|GMT\+10) \(Sydney time\)$/);
  });

  it("turns underscores into spaces", () => {
    const ba = { ...base, timezone: "America/Argentina/Buenos_Aires" };
    expect(timezoneName(ba)).toMatch(/ \(Buenos Aires time\)$/);
  });

  it("names no city for a zone that has none", () => {
    // "(UTC time)" and "(GMT+10 time)" say nothing the label didn't.
    expect(timezoneName({ ...base, timezone: "UTC" })).toBe("UTC");
    expect(timezoneName({ ...base, timezone: "Etc/GMT-10" })).not.toContain("time)");
  });

  it("is empty for an unparseable start", () => {
    expect(timezoneName({ ...base, startAt: "nope" })).toBe("");
  });
});

describe("guestLocalTime", () => {
  it("is null where the guest's clock reads the same as the event's", () => {
    // Melbourne and Sydney share a wall clock all year.
    expect(guestLocalTime(base, "Australia/Melbourne")).toBeNull();
    expect(guestLocalTime(base, "Australia/Sydney")).toBeNull();
  });

  it("gives the guest's own day, times and zone when they differ", () => {
    // 4 pm–10 pm Sydney on Friday 18 September is 7 am–1 pm in London.
    expect(plain(guestLocalTime(base, "Europe/London"))).toMatch(
      /^Fri 7:00 am – 1:00 pm \((BST|GMT\+1)\)$/,
    );
  });

  it("names the end's day when it falls on another day for the guest", () => {
    // 4 pm–10 pm Sydney is 11 pm Thursday to 5 am Friday in Los Angeles.
    expect(plain(guestLocalTime(base, "America/Los_Angeles"))).toMatch(
      /^Thu 11:00 pm – Fri 5:00 am \((PDT|GMT-7)\)$/,
    );
  });

  it("gives the guest's day and start alone when the event states no end", () => {
    expect(plain(guestLocalTime({ ...base, endAt: "" }, "Europe/London"))).toMatch(
      /^Fri 7:00 am \((BST|GMT\+1)\)$/,
    );
  });

  it("is null, not a throw, for a zone the browser reports that Intl rejects", () => {
    expect(guestLocalTime(base, "Not/A_Zone")).toBeNull();
    expect(guestLocalTime(base, "")).toBeNull();
  });

  it("is null for an unparseable start", () => {
    expect(guestLocalTime({ ...base, startAt: "nope" }, "Europe/London")).toBeNull();
  });
});

describe("guestTimeZone", () => {
  it("is the zone this runtime's clock is set to, an id Intl accepts", () => {
    const zone = guestTimeZone();
    expect(zone).toBe(new Intl.DateTimeFormat().resolvedOptions().timeZone);
    expect(() => new Intl.DateTimeFormat("en-AU", { timeZone: zone })).not.toThrow();
  });
});

describe("invitedNames", () => {
  const EVENT = base.id;
  const OTHER = "9f7a2c14-1b3d-4e5f-8a01-000000000002";
  const member = (
    firstName: string,
    eventIds: string[],
    extra: Partial<FamilyMember> = {},
  ): FamilyMember => ({
    guestId: `g-${firstName}-${extra.lastName ?? "Lee"}`,
    firstName,
    lastName: "Lee",
    nickname: null,
    eventIds,
    ...extra,
  });

  it("is null when everyone the couple invited is invited", () => {
    // A plus-one is not someone the couple left out.
    const members = [
      member("Ana", [EVENT]),
      member("Ben", [EVENT]),
      member("Cy", [EVENT], { plusOneOf: "g-Ana-Lee" }),
    ];
    expect(invitedNames(members, EVENT)).toBeNull();
  });

  it("is null for a household of one", () => {
    expect(invitedNames([member("Ana", [EVENT])], EVENT)).toBeNull();
  });

  it("names exactly the people invited, plus-ones included", () => {
    const members = [
      member("Ana", [EVENT]),
      member("Cy", [EVENT], { plusOneOf: "g-Ana-Lee" }),
      member("Ben", [OTHER]),
      member("Di", [EVENT, OTHER]),
    ];
    expect(invitedNames(members, EVENT)).toBe("Ana, Cy and Di");
  });

  it("tells two people with one first name apart", () => {
    const members = [
      member("Sam", [EVENT], { lastName: "Lee" }),
      member("Sam", [EVENT], { lastName: "Park" }),
      member("Jo", [OTHER]),
    ];
    expect(invitedNames(members, EVENT)).toBe("Sam Lee and Sam Park");
  });

  it("is null rather than an empty list when nobody has the event", () => {
    expect(invitedNames([member("Ana", [OTHER]), member("Ben", [OTHER])], EVENT)).toBeNull();
    expect(invitedNames([], EVENT)).toBeNull();
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
