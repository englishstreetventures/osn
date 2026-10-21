import { describe, it, expect } from "vitest";

import {
  formatEventDay,
  formatTimeRange,
  guestLocalTime,
  invitedNames,
  mapsDestinations,
  resolveMapsEmbedUrl,
  resolveMapsUrl,
  timezoneLabel,
  timezoneName,
  venueLine,
  venueLocation,
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

describe("venueLocation", () => {
  const at = (venueName: string | null | undefined, address: string | null) => ({
    venueName,
    address,
  });

  it("puts the venue's name before its address", () => {
    expect(venueLocation(at("The Glasshouse", "12 Banksia Lane, Strathfield"))).toBe(
      "The Glasshouse, 12 Banksia Lane, Strathfield",
    );
  });

  it("is the name alone when there is no address, and the address alone when there is no name", () => {
    expect(venueLocation(at("The Glasshouse", "  "))).toBe("The Glasshouse");
    expect(venueLocation(at(null, "12 Banksia Lane"))).toBe("12 Banksia Lane");
    // An API older than the venue name sends none.
    expect(venueLocation(at(undefined, "12 Banksia Lane"))).toBe("12 Banksia Lane");
  });

  it("is empty when there is neither", () => {
    expect(venueLocation(at("  ", null))).toBe("");
  });

  it("does not repeat a name the address already starts with", () => {
    expect(venueLocation(at("the grounds", "The Grounds of Alexandria, 7a Huntley St"))).toBe(
      "The Grounds of Alexandria, 7a Huntley St",
    );
  });

  it("keeps a name that only starts a longer word of the address", () => {
    expect(venueLocation(at("Hall", "Hallstrom Rd, Willoughby"))).toBe(
      "Hall, Hallstrom Rd, Willoughby",
    );
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

  // The address is the precise place, so it is the query when there is one;
  // a venue's name alone is still something a map can find.
  it("searches for the address over the venue's name, and for the name when there is no address", () => {
    const both = resolveMapsUrl({ ...base, venueName: "The Glasshouse" });
    expect(both).toContain(`query=${encodeURIComponent("12 Banksia Lane, Strathfield")}`);
    expect(resolveMapsUrl({ mapsUrl: null, address: null, venueName: " The Glasshouse " })).toBe(
      `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("The Glasshouse")}`,
    );
  });
});

describe("mapsDestinations", () => {
  const google = (q: string) =>
    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
  const apple = (q: string) => `https://maps.apple.com/?q=${encodeURIComponent(q)}`;
  const waze = (q: string) => `https://waze.com/ul?q=${encodeURIComponent(q)}&navigate=yes`;
  const labels = (e: Parameters<typeof mapsDestinations>[0]) =>
    mapsDestinations(e).map((d) => d.label);

  it("offers Google Maps, Apple Maps and Waze for the venue, the query escaped for each", () => {
    // Characters that would end or split a query string unescaped.
    const address = "12 Banksia Lane & Co, #2 / Strathfield?";
    expect(mapsDestinations({ ...base, address })).toEqual([
      { label: "Google Maps", href: google(address) },
      { label: "Apple Maps", href: apple(address) },
      { label: "Waze", href: waze(address) },
    ]);
  });

  it("searches for the venue's name when there is no address", () => {
    expect(
      mapsDestinations({ mapsUrl: null, address: null, venueName: " The Glasshouse " }),
    ).toEqual([
      { label: "Google Maps", href: google("The Glasshouse") },
      { label: "Apple Maps", href: apple("The Glasshouse") },
      { label: "Waze", href: waze("The Glasshouse") },
    ]);
  });

  // The organiser's own pin — an entrance, a car park — is better than a
  // search, so it takes the place of the provider whose link it is.
  it.each([
    ["Google Maps", "https://maps.google.com/?q=Strathfield+Town+Hall"],
    ["Google Maps", "https://www.google.com/maps/place/Strathfield+Town+Hall"],
    ["Google Maps", "https://google.co.uk/maps/@51.5,-0.1,15z"],
    ["Google Maps", "https://www.google.com.au/maps/dir//Strathfield"],
    ["Google Maps", "https://google.de/maps/place/Berlin"],
    ["Google Maps", "https://maps.app.goo.gl/q4Zt9XaBcDeF"],
    ["Google Maps", "https://goo.gl/maps/q4Zt9XaBcDeF"],
    ["Google Maps", "https://g.page/the-glasshouse"],
    ["Apple Maps", "https://maps.apple.com/?address=12+Banksia+Lane"],
    ["Apple Maps", "https://beta.maps.apple.com/place?id=123"],
    ["Apple Maps", "https://maps.apple/p/abc"],
    ["Waze", "https://waze.com/ul?ll=-33.87,151.08&navigate=yes"],
    ["Waze", "https://www.waze.com/live-map/directions?to=ll.-33.87,151.08"],
  ])("puts the organiser's link in place of %s for %s", (label, mapsUrl) => {
    const out = mapsDestinations({ ...base, mapsUrl });
    expect(out.map((d) => d.label)).toEqual(["Google Maps", "Apple Maps", "Waze"]);
    expect(out.find((d) => d.label === label)!.href).toBe(mapsUrl);
    for (const other of out.filter((d) => d.label !== label)) {
      expect(other.href).not.toBe(mapsUrl);
    }
  });

  it("puts an organiser's link from any other host first, as the venue's own map", () => {
    const mapsUrl = "https://www.thegrounds.com.au/getting-here";
    expect(mapsDestinations({ ...base, mapsUrl })).toEqual([
      { label: "Venue map", href: mapsUrl },
      { label: "Google Maps", href: google(base.address!) },
      { label: "Apple Maps", href: apple(base.address!) },
      { label: "Waze", href: waze(base.address!) },
    ]);
  });

  it.each([
    "https://goo.gl/xyz",
    "https://google.example.com/maps/place/x",
    "https://maps.google.example.com/?q=x",
    "https://www.google.com/search?q=strathfield",
    "https://notgoogle.com/maps/place/x",
    "https://google.com.evil/maps/x",
    "https://apple.com/maps",
    "https://maps.apple.com.evil.test/?q=x",
    "https://notwaze.com/ul?q=x",
  ])("takes no look-alike for a provider: %s is the venue's own map", (mapsUrl) => {
    expect(labels({ ...base, mapsUrl })).toEqual([
      "Venue map",
      "Google Maps",
      "Apple Maps",
      "Waze",
    ]);
  });

  it("ignores an organiser link that is not http(s)", () => {
    for (const mapsUrl of ["javascript:alert(1)", "ftp://maps.google.com/x", "not a url"]) {
      const out = mapsDestinations({ ...base, mapsUrl });
      expect(out.map((d) => d.label)).toEqual(["Google Maps", "Apple Maps", "Waze"]);
      expect(out.every((d) => d.href.startsWith("https://"))).toBe(true);
    }
  });

  it("offers the organiser's link alone when there is nothing to search for", () => {
    const pinned = "https://maps.google.com/?q=somewhere";
    expect(mapsDestinations({ mapsUrl: pinned, address: null })).toEqual([
      { label: "Google Maps", href: pinned },
    ]);
    const own = "https://venue.example.com/map";
    expect(mapsDestinations({ mapsUrl: ` ${own} `, address: "  " })).toEqual([
      { label: "Venue map", href: own },
    ]);
  });

  it("offers nothing when there is nothing to point at", () => {
    expect(mapsDestinations({ mapsUrl: null, address: null })).toEqual([]);
    expect(
      mapsDestinations({ mapsUrl: "javascript:alert(1)", address: " ", venueName: "" }),
    ).toEqual([]);
  });

  // `hasVenue` and the row's `Show` ask `resolveMapsUrl`; the row's contents
  // come from here. The two must agree, or the row shows with nothing in it.
  it("has somewhere to go exactly when resolveMapsUrl does", () => {
    const cases = [
      { mapsUrl: null, address: null, venueName: null },
      { mapsUrl: null, address: "12 Banksia Lane", venueName: null },
      { mapsUrl: null, address: null, venueName: "The Glasshouse" },
      { mapsUrl: "https://maps.google.com/?q=x", address: null, venueName: null },
      { mapsUrl: "https://venue.example.com", address: null, venueName: null },
      { mapsUrl: "javascript:alert(1)", address: null, venueName: null },
      { mapsUrl: "javascript:alert(1)", address: "12 Banksia Lane", venueName: null },
      { mapsUrl: "   ", address: "   ", venueName: "   " },
    ];
    for (const e of cases) {
      expect({ e, has: mapsDestinations(e).length > 0 }).toEqual({
        e,
        has: resolveMapsUrl(e) !== null,
      });
    }
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

  it("queries the venue's name when there is no address", () => {
    expect(resolveMapsEmbedUrl({ address: null, venueName: "The Glasshouse" }, KEY)).toContain(
      `q=${encodeURIComponent("The Glasshouse")}`,
    );
    expect(resolveMapsEmbedUrl({ ...base, venueName: "The Glasshouse" }, KEY)).toContain(
      `q=${encodeURIComponent("12 Banksia Lane, Strathfield")}`,
    );
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
