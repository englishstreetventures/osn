import { describe, expect, it } from "vitest";

import { onRequestGet } from "./geo";

// The function only reads `request.cf`, so a partial stub is enough. Cast through
// `unknown` to the real parameter type to stay `any`-free.
type Ctx = Parameters<typeof onRequestGet>[0];
function call(cf: Record<string, string> | undefined) {
  return onRequestGet({ request: { cf } } as unknown as Ctx);
}

describe("GET /api/geo", () => {
  it("maps full edge geo to city/region/country + an in-range count", async () => {
    const res = call({ city: "Austin", region: "Texas", regionCode: "TX", country: "US" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");

    const body = await res.json();
    expect(body).toMatchObject({
      city: "Austin",
      region: "Texas",
      regionCode: "TX",
      country: "US",
    });
    expect(body.count).toBeGreaterThanOrEqual(20);
    expect(body.count).toBeLessThanOrEqual(179);
  });

  it("prefers region over city for the count's place, and is deterministic", async () => {
    // region present → city is ignored, so the count matches the region-only call.
    const withCity = await call({ region: "Texas", city: "Austin" }).json();
    const regionOnly = await call({ region: "Texas" }).json();
    expect(withCity.count).toBe(regionOnly.count);

    // Falls through to city, then country, when region is absent — each still
    // resolves a count in range.
    const cityOnly = await call({ city: "Austin" }).json();
    const countryOnly = await call({ country: "US" }).json();
    for (const n of [cityOnly.count, countryOnly.count]) {
      expect(n).toBeGreaterThanOrEqual(20);
      expect(n).toBeLessThanOrEqual(179);
    }
  });

  it("returns all-null with a null count when no location resolves", async () => {
    const empty = await call({}).json();
    expect(empty).toEqual({
      city: null,
      region: null,
      regionCode: null,
      country: null,
      count: null,
    });

    // Missing `cf` entirely is treated the same way (no crash, count null).
    const none = await call(undefined).json();
    expect(none.count).toBeNull();
  });
});
