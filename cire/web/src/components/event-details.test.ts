import { describe, it, expect } from "vitest";

import {
  formatEventDay,
  formatTimeRange,
  resolveMapsEmbedUrl,
  resolveMapsUrl,
  timezoneLabel,
  venueLine,
} from "./event-details";
import type { EventSummary } from "./types";

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
