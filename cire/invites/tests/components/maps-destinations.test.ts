/**
 * What "Open in maps" offers: Google Maps, Apple Maps and Waze for the venue,
 * with the organiser's own link in place of the app it belongs to.
 */
import { describe, it, expect } from "vitest";

import { resolveMapsUrl } from "../../src/components/event-details";
import { mapsDestinations } from "../../src/components/maps-destinations";
import type { EventSummary } from "../../src/components/types";

const base: Pick<EventSummary, "mapsUrl" | "address" | "venueName"> = {
  mapsUrl: null,
  address: "12 Banksia Lane, Strathfield",
};

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
    ["Google Maps", "https://maps.google.co.jp/?q=Shibuya"],
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
    // `com.de` and `co.de` are ordinary domains, anyone's to register: only
    // the country domains whose second level its registry runs are Google's.
    "https://maps.google.com.de/x",
    "https://maps.google.co.de/x",
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

  it("keeps an organiser's plain http link", () => {
    const mapsUrl = "http://www.thegrounds.com.au/getting-here";
    expect(mapsDestinations({ ...base, mapsUrl })[0]).toEqual({
      label: "Venue map",
      href: mapsUrl,
    });
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
