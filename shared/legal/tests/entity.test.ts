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
   * notice renders one and the terms the other. No page publishes a postal
   * address, so there is none to check.
   */
  it("names the operator and both mailboxes", () => {
    expect(new Set(IDENTITY_FIELD_NAMES)).toEqual(
      new Set(["name", "privacyEmail", "supportEmail"]),
    );
    expect(IDENTITY_FIELD_NAMES).toHaveLength(3);
  });
});

describe("LEGAL_DETAILS_PENDING", () => {
  /**
   * Every identity field is filled, so no page is a draft on their account.
   * A placeholder put back into any of them fails this test, and shows every
   * page's banner again.
   */
  it("is false once every identity field is filled", () => {
    expect(IDENTITY_FIELD_NAMES.filter((field) => isPlaceholder(LEGAL_ENTITY[field]))).toEqual([]);
    expect(LEGAL_DETAILS_PENDING).toBe(false);
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

  /** Only what a page must publish: the operator's name, its two mailboxes,
   *  the regulator and the governing law. No postal address, no company
   *  number. */
  it("holds the operator's published details and nothing else", () => {
    expect(Object.keys(LEGAL_ENTITY).sort()).toEqual([
      "governingLaw",
      "name",
      "privacyEmail",
      "regulator",
      "supportEmail",
    ]);
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
