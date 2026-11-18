import { describe, expect, it } from "vitest";

import {
  draftPending,
  IDENTITY_FIELD_NAMES,
  isPlaceholder,
  LEGAL_DETAILS_PENDING,
  LEGAL_ENTITY,
} from "../src/index";

describe("isPlaceholder", () => {
  it("recognises an unfilled token", () => {
    expect(isPlaceholder("{{LEGAL_ENTITY}}")).toBe(true);
  });

  it("does not fire on ordinary copy that merely contains braces", () => {
    expect(isPlaceholder("Example Pty Ltd {trading as Example}")).toBe(false);
    expect(isPlaceholder("Example Pty Ltd")).toBe(false);
  });
});

describe("IDENTITY_FIELD_NAMES", () => {
  /**
   * Every page renders at least one of these, so a placeholder in any of them
   * must show every page's draft banner. Both mailboxes are here: a privacy
   * notice renders one and the terms the other.
   */
  it("names the operator, its address and both mailboxes", () => {
    expect(new Set(IDENTITY_FIELD_NAMES)).toEqual(
      new Set(["name", "postalAddress", "privacyEmail", "supportEmail"]),
    );
    expect(IDENTITY_FIELD_NAMES).toHaveLength(4);
  });
});

describe("LEGAL_DETAILS_PENDING", () => {
  /**
   * The postal address is still a placeholder, so every page must be flagged
   * a draft. When the address is filled this test fails on purpose: replace it
   * with one asserting `false`, once every identity field is real.
   */
  it("is true while the postal address is still a placeholder", () => {
    expect(LEGAL_ENTITY.postalAddress).toBe("{{POSTAL_ADDRESS}}");
    expect(LEGAL_DETAILS_PENDING).toBe(true);
  });
});

describe("LEGAL_ENTITY", () => {
  it("names New South Wales as the governing law", () => {
    expect(LEGAL_ENTITY.governingLaw).toBe("New South Wales, Australia");
  });

  it("keeps privacy requests and everything else in separate mailboxes", () => {
    expect(LEGAL_ENTITY.privacyEmail).toMatch(/^privacy@/);
    expect(LEGAL_ENTITY.supportEmail).toMatch(/^hello@/);
  });
});

describe("draftPending", () => {
  it("passes a page whose extra fields are all answered", () => {
    expect(draftPending(LEGAL_ENTITY.governingLaw)).toBe(LEGAL_DETAILS_PENDING);
  });

  /**
   * The regression this function exists for. A page naming an extra field must
   * stay flagged even once the identity fields are all filled in, and the
   * caller must not have to remember to check the identity half.
   */
  it("keeps flagging an unfilled extra once the identity is complete", () => {
    expect(draftPending("Example Pty Ltd", "{{EXTRA_FIELD}}")).toBe(true);
  });

  it("covers the identity half even when handed nothing", () => {
    expect(draftPending()).toBe(LEGAL_DETAILS_PENDING);
  });
});
