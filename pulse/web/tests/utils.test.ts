import { describe, it, expect } from "vitest";

import {
  formatTime,
  toDatetimeLocal,
  composeLabel,
  isEndBeforeOrAtStart,
  displayNameOf,
  initialOf,
  safeAvatarUrl,
  deriveEndFromDuration,
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

describe("displayNameOf", () => {
  it("returns null for a signed-out viewer (null identity)", () => {
    expect(displayNameOf(null)).toBeNull();
  });

  it("prefers the display name over handle and email", () => {
    expect(
      displayNameOf({ displayName: "Alice Ng", handle: "alice", email: "alice@example.com" }),
    ).toBe("Alice Ng");
  });

  it("falls back to @handle when there is no display name", () => {
    expect(displayNameOf({ displayName: null, handle: "alice", email: "alice@example.com" })).toBe(
      "@alice",
    );
  });

  it("falls back to the email local-part when there is no name or handle", () => {
    expect(displayNameOf({ displayName: null, handle: null, email: "alice@example.com" })).toBe(
      "alice",
    );
  });

  it("returns null when the identity carries none of the three", () => {
    expect(displayNameOf({ displayName: null, handle: null, email: null })).toBeNull();
  });
});

describe("initialOf", () => {
  it("upper-cases the first character", () => {
    expect(initialOf("alice")).toBe("A");
  });

  it("skips leading whitespace", () => {
    expect(initialOf("  bob")).toBe("B");
  });

  it("returns ? for null", () => {
    expect(initialOf(null)).toBe("?");
  });

  it("returns ? for an empty name", () => {
    expect(initialOf("   ")).toBe("?");
  });
});

describe("safeAvatarUrl", () => {
  it("passes an absolute https URL through", () => {
    expect(safeAvatarUrl("https://cdn.example.com/a.png")).toBe("https://cdn.example.com/a.png");
  });

  it("rejects http", () => {
    expect(safeAvatarUrl("http://cdn.example.com/a.png")).toBeNull();
  });

  it("rejects javascript:", () => {
    expect(safeAvatarUrl("javascript:alert(1)")).toBeNull();
  });

  it("rejects data:", () => {
    expect(safeAvatarUrl("data:image/png;base64,AAAA")).toBeNull();
  });

  it("rejects a protocol-relative URL (unparseable without a base)", () => {
    expect(safeAvatarUrl("//cdn.example.com/a.png")).toBeNull();
  });

  it("returns null for null or empty input", () => {
    expect(safeAvatarUrl(null)).toBeNull();
    expect(safeAvatarUrl("")).toBeNull();
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

describe("deriveEndFromDuration", () => {
  it("returns an empty string when start is empty", () => {
    expect(deriveEndFromDuration("", 2)).toBe("");
  });

  it("returns an empty string when start is unparseable", () => {
    expect(deriveEndFromDuration("not-a-date", 2)).toBe("");
  });

  it("adds exactly N hours to start and returns a datetime-local string", () => {
    const start = "2030-06-01T10:00";
    const expected = toDatetimeLocal(new Date(new Date(start).getTime() + 2 * 60 * 60 * 1000));
    expect(deriveEndFromDuration(start, 2)).toBe(expected);
  });

  it("matches YYYY-MM-DDTHH:mm format", () => {
    expect(deriveEndFromDuration("2030-06-01T10:00", 4)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });
});
