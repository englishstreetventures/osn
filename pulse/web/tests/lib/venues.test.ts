// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeOpenStatus,
  fetchAllVenues,
  fetchEventLineup,
  fetchVenue,
  fetchVenueEvents,
  parseVenueHours,
  safeHttpUrl,
  venueMapsUrl,
  type VenueSummary,
} from "../../src/lib/venues";

// ---------------------------------------------------------------------------
// parseVenueHours
// ---------------------------------------------------------------------------

describe("parseVenueHours", () => {
  it("returns null when the input is null", () => {
    expect(parseVenueHours(null)).toBeNull();
  });

  it("parses a valid hours map", () => {
    const raw = JSON.stringify({ "5": { open: "22:00", close: "04:00" }, "1": null });
    const parsed = parseVenueHours(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!["5"]).toEqual({ open: "22:00", close: "04:00" });
    expect(parsed!["1"]).toBeNull();
  });

  it("returns null on invalid JSON instead of throwing", () => {
    expect(parseVenueHours("not-json")).toBeNull();
  });

  it("returns null when the parsed value is not an object", () => {
    expect(parseVenueHours("42")).toBeNull();
    expect(parseVenueHours("null")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// venueMapsUrl
// ---------------------------------------------------------------------------

const baseVenue: VenueSummary = {
  id: "v1",
  orgHandle: "org",
  handle: "venue",
  name: "Venue",
  kind: "club",
  description: null,
  address: null,
  city: null,
  country: null,
  latitude: null,
  longitude: null,
  capacity: null,
  hours: null,
  heroImageUrl: null,
  websiteUrl: null,
  instagramHandle: null,
  timezone: "UTC",
};

describe("venueMapsUrl", () => {
  it("prefers lat/lng coordinates when present", () => {
    const url = venueMapsUrl({ ...baseVenue, latitude: 40.7197, longitude: -73.9879 });
    expect(url).toBe("https://www.google.com/maps/search/?api=1&query=40.7197,-73.9879");
  });

  it("falls back to an encoded address when coords are missing", () => {
    const url = venueMapsUrl({
      ...baseVenue,
      address: "152 Orchard St",
      city: "New York",
      country: "USA",
    });
    expect(url).toBe(
      "https://www.google.com/maps/search/?api=1&query=152%20Orchard%20St%2C%20New%20York%2C%20USA",
    );
  });

  it("returns null when there's no coords and no address pieces", () => {
    expect(venueMapsUrl(baseVenue)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computeOpenStatus — the wall-clock-sensitive bits
// ---------------------------------------------------------------------------

describe("computeOpenStatus", () => {
  const hours = {
    "5": { open: "22:00", close: "04:00" }, // Fri opens late, into Sat
  };

  it("reports open during a slot that crosses midnight (Sat 02:00 NY)", () => {
    // 2030-06-08 06:00 UTC = Sat 02:00 EDT — inside the Fri 22:00 → Sat 04:00 slot.
    const at = new Date("2030-06-08T06:00:00.000Z");
    const s = computeOpenStatus(hours, "America/New_York", at);
    expect(s.isOpen).toBe(true);
    expect(s.label).toContain("closes");
  });

  it("reports closed and proposes the next opening when outside any slot", () => {
    // 2030-06-07 18:00 UTC = Fri 14:00 EDT — Fri slot opens at 22:00 EDT.
    const at = new Date("2030-06-07T18:00:00.000Z");
    const s = computeOpenStatus(hours, "America/New_York", at);
    expect(s.isOpen).toBe(false);
    expect(s.label.toLowerCase()).toMatch(/opens|closed/);
  });
});

// ---------------------------------------------------------------------------
// fetchAllVenues
// ---------------------------------------------------------------------------

describe("fetchAllVenues", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("returns the venues array on a 200 response", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ venues: [baseVenue] }),
    });
    const result = await fetchAllVenues();
    expect(result).toEqual([baseVenue]);
  });

  it("returns an empty array on a non-OK response (fail-soft)", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: async () => ({}),
    });
    const result = await fetchAllVenues();
    expect(result).toEqual([]);
  });

  it("returns an empty array when the body has no venues key", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });
    const result = await fetchAllVenues();
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchVenue / fetchVenueEvents / fetchEventLineup
// ---------------------------------------------------------------------------

describe("venue fetchers", () => {
  const realFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  describe("fetchVenue", () => {
    it("returns the venue on a 200 response", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ venue: baseVenue }) });
      expect(await fetchVenue("org", "venue")).toEqual(baseVenue);
    });

    it("returns null on a non-OK response (fail-soft)", async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
      expect(await fetchVenue("org", "venue")).toBeNull();
    });

    it("returns null when the body has no venue key", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await fetchVenue("org", "venue")).toBeNull();
    });

    it("URL-encodes path segments (S-L2)", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      await fetchVenue("org/with?chars", "venue#frag");
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/venues/org%2Fwith%3Fchars/venue%23frag");
    });
  });

  describe("fetchVenueEvents", () => {
    it("returns the events array on a 200 response", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ events: [{ id: "e1" }] }) });
      expect(await fetchVenueEvents("org", "venue")).toEqual([{ id: "e1" }]);
    });

    it("returns an empty array on a non-OK response (fail-soft)", async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
      expect(await fetchVenueEvents("org", "venue")).toEqual([]);
    });

    it("returns an empty array when the body has no events key", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await fetchVenueEvents("org", "venue")).toEqual([]);
    });

    it("passes scope and an optional limit as query params", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      await fetchVenueEvents("org", "venue", "past", 1);
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("scope=past");
      expect(url).toContain("limit=1");
    });
  });

  describe("fetchEventLineup", () => {
    it("returns the slots array on a 200 response", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ slots: [{ id: "s1" }] }) });
      expect(await fetchEventLineup("org", "venue", "evt")).toEqual([{ id: "s1" }]);
    });

    it("returns an empty array on a non-OK response (fail-soft)", async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => ({}) });
      expect(await fetchEventLineup("org", "venue", "evt")).toEqual([]);
    });

    it("returns an empty array when the body has no slots key", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      expect(await fetchEventLineup("org", "venue", "evt")).toEqual([]);
    });

    it("URL-encodes the eventId segment (S-L2)", async () => {
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
      await fetchEventLineup("org", "venue", "evt/../../sneaky");
      const url = fetchMock.mock.calls[0]![0] as string;
      expect(url).toContain("/events/evt%2F..%2F..%2Fsneaky/lineup");
    });
  });
});

// ---------------------------------------------------------------------------
// safeHttpUrl (S-M2)
// ---------------------------------------------------------------------------

describe("safeHttpUrl", () => {
  it("passes https URLs through", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
  });

  it("passes http URLs through", () => {
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects javascript: URLs", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(safeHttpUrl("data:text/html,<script>1</script>")).toBeNull();
  });

  it("rejects unparseable values", () => {
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("returns null for null", () => {
    expect(safeHttpUrl(null)).toBeNull();
  });
});
