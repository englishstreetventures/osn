import { describe, expect, it } from "vitest";

import { isIsoTimestamp } from "../../src/lib/guest-validation";

/**
 * `isIsoTimestamp` is the client mirror of `cire/api/src/lib/event-time.ts`'s
 * `parseWallTime` — the module's own header comment says the two must agree
 * exactly, since a value the editor accepts but the sheet path (or a re-import
 * of an exported draft) rejects would pass client validation and then fail at
 * Save with no local warning. These cases track `event-time.test.ts`'s table
 * for `parseWallTime` one-for-one.
 */
describe("isIsoTimestamp", () => {
  it("accepts a bare local wall clock — no offset required", () => {
    expect(isIsoTimestamp("2026-11-14T15:00")).toBe(true);
  });

  it("accepts seconds", () => {
    expect(isIsoTimestamp("2026-11-14T15:00:30")).toBe(true);
  });

  it("accepts a trailing offset or Z — the stamped, canonical stored shape", () => {
    expect(isIsoTimestamp("2026-11-14T15:00+11:00")).toBe(true);
    expect(isIsoTimestamp("2026-11-14T15:00:00+11:00")).toBe(true);
    expect(isIsoTimestamp("2026-11-14T15:00:00Z")).toBe(true);
  });

  it("rejects a trailing tail Date would swallow but neither front door can round-trip", () => {
    expect(isIsoTimestamp("2026-11-14T15:00 GMT")).toBe(false);
  });

  it("rejects free text and date-only values", () => {
    for (const bad of ["", "TBD", "1st Nov 2026", "18/09/2026 4pm", "2026-11-14"]) {
      expect(isIsoTimestamp(bad)).toBe(false);
    }
  });

  it("rejects an impossible clock reading the pattern alone would admit", () => {
    expect(isIsoTimestamp("2026-13-40T99:99")).toBe(false);
  });
});
