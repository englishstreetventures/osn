import { describe, expect, it } from "vitest";

import { onRequestGet } from "../../../functions/api/geo";

// The function only reads `request.cf`, so a partial stub is enough. Cast through
// `unknown` to the real parameter type to stay `any`-free.
type Ctx = Parameters<typeof onRequestGet>[0];
function call(cf: Record<string, string> | undefined) {
  return onRequestGet({ request: { cf } } as unknown as Ctx);
}

describe("GET /api/geo", () => {
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
});
