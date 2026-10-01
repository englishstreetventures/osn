import { describe, expect, it } from "bun:test";

import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
  PLUS_ONE_DIETARY_ATTESTATION,
} from "../src/index";

/** A version without its trailing date: the part that names whose words. */
const stem = (version: string): string => version.replace(/-\d{4}-\d{2}-\d{2}$/, "");

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

describe("ORGANISER_PLUS_ONE_DIETARY_ATTESTATION", () => {
  /**
   * Pinned together for the same reason as the others: the API stamps the
   * version onto every organiser-recorded plus-one's reply as the evidence of
   * which words the organiser ticked. Change the version with the words.
   */
  it("pins the wording to its version", () => {
    expect(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version).toBe("organiser-plus-one-2026-10-01");
    expect(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text).toBe(
      "I confirm the plus-one consented to their dietary requirements being stored and shared with the caterers for this wedding.",
    );
  });

  it("speaks of the plus-one, not the guest", () => {
    expect(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text).toContain("the plus-one");
    expect(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text).not.toContain("the guest");
  });
});

describe("attestation versions", () => {
  /**
   * A stored version must say whose words it names on its own, so every
   * copy's stem differs from every other's and none is a bare date (the
   * guest's own-consent version's shape).
   */
  it("each names one copy", () => {
    const versions = [
      PLUS_ONE_DIETARY_ATTESTATION.version,
      ORGANISER_DIETARY_ATTESTATION.version,
      ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version,
    ];
    for (const version of versions) {
      expect(version).not.toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(stem(version)).not.toBe(version);
    }
    expect(new Set(versions.map(stem)).size).toBe(versions.length);
  });
});
