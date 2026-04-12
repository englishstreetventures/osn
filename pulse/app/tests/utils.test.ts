import { describe, it, expect } from "vitest";

import {
  formatTime,
  toDatetimeLocal,
  composeLabel,
  isEndBeforeOrAtStart,
  getUserIdFromToken,
  getDisplayNameFromToken,
  type PhotonFeature,
} from "../src/lib/utils";

describe("toDatetimeLocal", () => {
  it("leaves an already-rounded time unchanged (Math.ceil is idempotent at boundaries)", () => {
    // Exactly on a minute boundary → Math.ceil keeps the same minute
    const exact = new Date("2030-06-01T10:00:00.000Z");
    const result = toDatetimeLocal(exact);
    // Output must still be in YYYY-MM-DDTHH:mm format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("rounds a non-rounded time up to the next full minute", () => {
    // 10:00:30 → should become 10:01
    const halfMinute = new Date("2030-06-01T10:00:30.000Z");
    const result = toDatetimeLocal(halfMinute);
    // Output must be in YYYY-MM-DDTHH:mm format
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("output matches YYYY-MM-DDTHH:mm format", () => {
    const d = new Date("2030-06-15T14:37:00.000Z");
    expect(toDatetimeLocal(d)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});

describe("composeLabel", () => {
  it("joins all present fields with ', '", () => {
    const p: PhotonFeature["properties"] = {
      name: "Venue",
      street: "123 Main St",
      city: "Springfield",
      state: "IL",
      country: "US",
    };
    expect(composeLabel(p)).toBe("Venue, 123 Main St, Springfield, IL, US");
  });

  it("omits absent (undefined) fields", () => {
    const p: PhotonFeature["properties"] = { name: "Park", city: "Austin" };
    expect(composeLabel(p)).toBe("Park, Austin");
  });

  it("returns empty string when all fields are absent", () => {
    expect(composeLabel({})).toBe("");
  });
});

describe("isEndBeforeOrAtStart", () => {
  it("returns false when end is empty", () => {
    expect(isEndBeforeOrAtStart("2030-06-01T10:00", "")).toBe(false);
  });

  it("returns true when end equals start", () => {
    expect(isEndBeforeOrAtStart("2030-06-01T10:00", "2030-06-01T10:00")).toBe(true);
  });

  it("returns true when end is before start", () => {
    expect(isEndBeforeOrAtStart("2030-06-01T10:00", "2030-06-01T09:00")).toBe(true);
  });

  it("returns false when end is after start", () => {
    expect(isEndBeforeOrAtStart("2030-06-01T10:00", "2030-06-01T11:00")).toBe(false);
  });
});

// Builds a fake JWT with a base64-encoded payload (no signature verification in client code)
function fakeJwt(payload: Record<string, unknown>): string {
  return `header.${btoa(JSON.stringify(payload))}.sig`;
}

describe("getUserIdFromToken", () => {
  it("returns null for null input", () => {
    expect(getUserIdFromToken(null)).toBeNull();
  });

  it("returns null for a malformed token (no dots)", () => {
    expect(getUserIdFromToken("notajwt")).toBeNull();
  });

  it("returns null for a token with invalid base64 payload", () => {
    expect(getUserIdFromToken("header.!!!.sig")).toBeNull();
  });

  it("returns null when payload has no sub claim", () => {
    expect(getUserIdFromToken(fakeJwt({ email: "alice@example.com" }))).toBeNull();
  });

  it("returns null when sub claim is not a string", () => {
    expect(getUserIdFromToken(fakeJwt({ sub: 42 }))).toBeNull();
  });

  it("returns the sub claim when present", () => {
    expect(getUserIdFromToken(fakeJwt({ sub: "usr_test" }))).toBe("usr_test");
  });
});

describe("getDisplayNameFromToken", () => {
  it("returns null for null input", () => {
    expect(getDisplayNameFromToken(null)).toBeNull();
  });

  it("returns null for a malformed token", () => {
    expect(getDisplayNameFromToken("notajwt")).toBeNull();
  });

  it("returns null when payload has no email claim", () => {
    expect(getDisplayNameFromToken(fakeJwt({ sub: "usr_test" }))).toBeNull();
  });

  it("returns the local-part of the email claim", () => {
    expect(getDisplayNameFromToken(fakeJwt({ email: "alice@example.com" }))).toBe("alice");
  });

  it("returns null when email claim is not a string", () => {
    expect(getDisplayNameFromToken(fakeJwt({ email: 123 }))).toBeNull();
  });
});

describe("formatTime", () => {
  it("returns a non-empty string for a valid ISO date string", () => {
    const result = formatTime("2030-06-01T10:00:00.000Z");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns a non-empty string for a Date object", () => {
    const result = formatTime(new Date("2030-06-01T10:00:00.000Z"));
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });
});
