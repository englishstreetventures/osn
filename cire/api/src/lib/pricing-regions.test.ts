import { describe, expect, it } from "bun:test";

import { derivePricingRegion, isPricingRegion, PRICING_REGIONS } from "./pricing-regions";

describe("isPricingRegion", () => {
  it("accepts every member of the closed set", () => {
    for (const region of PRICING_REGIONS) {
      expect(isPricingRegion(region)).toBe(true);
    }
  });

  it("rejects anything outside it", () => {
    expect(isPricingRegion("au-sydney")).toBe(false);
    expect(isPricingRegion("")).toBe(false);
    expect(isPricingRegion("AU-NSW")).toBe(false);
  });
});

describe("derivePricingRegion", () => {
  it("maps every AU state/territory short code to its region", () => {
    expect(derivePricingRegion("AU", "NSW")).toBe("au-nsw");
    expect(derivePricingRegion("AU", "VIC")).toBe("au-vic");
    expect(derivePricingRegion("AU", "QLD")).toBe("au-qld");
    expect(derivePricingRegion("AU", "WA")).toBe("au-wa");
    expect(derivePricingRegion("AU", "SA")).toBe("au-sa");
    expect(derivePricingRegion("AU", "TAS")).toBe("au-tas");
    expect(derivePricingRegion("AU", "ACT")).toBe("au-act");
    expect(derivePricingRegion("AU", "NT")).toBe("au-nt");
  });

  it("is case-insensitive on both inputs", () => {
    expect(derivePricingRegion("au", "nsw")).toBe("au-nsw");
  });

  it("maps an AU address without a recognisable state to au-other", () => {
    expect(derivePricingRegion("AU", null)).toBe("au-other");
    expect(derivePricingRegion("AU", "New South Wales")).toBe("au-other");
  });

  it("maps non-AU and unknown countries to international", () => {
    expect(derivePricingRegion("NZ", "AUK")).toBe("international");
    expect(derivePricingRegion(null, "NSW")).toBe("international");
  });
});
