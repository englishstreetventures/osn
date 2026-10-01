import { describe, expect, it } from "bun:test";

import { ORGANISER_DIETARY_ATTESTATION, PLUS_ONE_DIETARY_ATTESTATION } from "../src/index";

describe("PLUS_ONE_DIETARY_ATTESTATION", () => {
  /**
   * The wording and the version are pinned together, in one test, on purpose.
   * The API stamps the version onto every attested row as the evidence of which
   * words the household ticked, so a change to the words that leaves the
   * version alone makes that evidence false. If this fails because the wording
   * changed, change the version in the same commit, then update both strings
   * here.
   */
  it("pins the wording to its version", () => {
    expect(PLUS_ONE_DIETARY_ATTESTATION.version).toBe("inviter-2026-09-27");
    expect(PLUS_ONE_DIETARY_ATTESTATION.text("Sam")).toBe(
      "I confirm that Sam agreed to their dietary requirements above being stored and shared with the caterers for this wedding.",
    );
  });

  it("names everyone the tick covers", () => {
    expect(PLUS_ONE_DIETARY_ATTESTATION.text("Sam and Alex")).toContain("Sam and Alex agreed");
  });

  /**
   * The guest's own-consent version is a bare date (`DIETARY_CONSENT_VERSION`
   * in `cire/api/src/schemas/rsvp.ts`). A stored version must say which of the
   * two copies it names, so this one can never take the same shape.
   */
  it("can never be mistaken for a date-only consent version", () => {
    expect(PLUS_ONE_DIETARY_ATTESTATION.version).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("ORGANISER_DIETARY_ATTESTATION", () => {
  /**
   * Pinned together for the same reason as the household's: the API stamps
   * the version onto every organiser-recorded row as the evidence of which
   * words the organiser ticked. Change the version with the words.
   */
  it("pins the wording to its version", () => {
    expect(ORGANISER_DIETARY_ATTESTATION.version).toBe("organiser-2026-10-01");
    expect(ORGANISER_DIETARY_ATTESTATION.text).toBe(
      "I confirm the guest consented to their dietary requirements being stored and shared with the caterers for this wedding.",
    );
  });

  it("can never be mistaken for another copy's version", () => {
    expect(ORGANISER_DIETARY_ATTESTATION.version).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(ORGANISER_DIETARY_ATTESTATION.version.split("-")[0]).not.toBe(
      PLUS_ONE_DIETARY_ATTESTATION.version.split("-")[0],
    );
  });
});
