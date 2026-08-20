import { describe, expect, it } from "vitest";

import { isPlaceholder, LEGAL_DETAILS_PENDING, LEGAL_ENTITY } from "../src/index";

describe("isPlaceholder", () => {
  it("recognises an unfilled token", () => {
    expect(isPlaceholder("{{LEGAL_ENTITY}}")).toBe(true);
  });

  it("does not fire on ordinary copy that merely contains braces", () => {
    expect(isPlaceholder("Example Pty Ltd {trading as Example}")).toBe(false);
    expect(isPlaceholder("Example Pty Ltd")).toBe(false);
  });
});

describe("LEGAL_DETAILS_PENDING", () => {
  it("agrees with the fields it is derived from", () => {
    const anyUnfilled = [
      LEGAL_ENTITY.name,
      LEGAL_ENTITY.postalAddress,
      LEGAL_ENTITY.contactEmail,
    ].some(isPlaceholder);
    expect(LEGAL_DETAILS_PENDING).toBe(anyUnfilled);
  });
});

describe("LEGAL_ENTITY", () => {
  /**
   * The regulator and the governing law are answers, not placeholders — both
   * were decided rather than deferred, so a page may state them even while the
   * entity's own details are pending.
   */
  it("names a regulator and a governing law", () => {
    expect(isPlaceholder(LEGAL_ENTITY.regulator)).toBe(false);
    expect(isPlaceholder(LEGAL_ENTITY.governingLaw)).toBe(false);
  });

  it("states governing law at country level, not state level", () => {
    expect(LEGAL_ENTITY.governingLaw).toBe("Australia");
  });
});
