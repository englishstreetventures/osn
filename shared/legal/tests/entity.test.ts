import { describe, expect, it } from "vitest";

import { draftPending, isPlaceholder, LEGAL_DETAILS_PENDING, LEGAL_ENTITY } from "../src/index";

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
  it("agrees with the identity fields it is derived from", () => {
    const anyUnfilled = [
      LEGAL_ENTITY.name,
      LEGAL_ENTITY.postalAddress,
      LEGAL_ENTITY.contactEmail,
    ].some(isPlaceholder);
    expect(LEGAL_DETAILS_PENDING).toBe(anyUnfilled);
  });
});

describe("draftPending", () => {
  it("flags a field outside the identity set", () => {
    expect(draftPending(LEGAL_ENTITY.merchantOfRecord)).toBe(true);
  });

  it("passes a page whose extra fields are all answered", () => {
    expect(draftPending(LEGAL_ENTITY.governingLaw)).toBe(LEGAL_DETAILS_PENDING);
  });

  /**
   * The regression this function exists for. A page naming the merchant of
   * record must stay flagged even once the identity fields are all filled in,
   * and the caller must not have to remember to check the identity half.
   */
  it("keeps flagging an unfilled extra once the identity is complete", () => {
    expect(draftPending("Example Pty Ltd", "{{MERCHANT_OF_RECORD}}")).toBe(true);
  });

  it("covers the identity half even when handed nothing", () => {
    expect(draftPending()).toBe(LEGAL_DETAILS_PENDING);
  });
});
