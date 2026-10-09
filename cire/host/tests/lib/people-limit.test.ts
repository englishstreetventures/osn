import { describe, expect, it } from "vitest";

import {
  atPeopleLimit,
  peopleCountLabel,
  peopleLimitMessage,
  readPeopleLimit,
  upgradeTierFor,
} from "../../src/lib/people-limit";

describe("readPeopleLimit", () => {
  it("reads the API's { used, limit, tier }", () => {
    expect(readPeopleLimit({ used: 4, limit: 6, tier: "ivory" })).toEqual({
      used: 4,
      limit: 6,
      tier: "ivory",
    });
    expect(readPeopleLimit({ used: 40, limit: 40, tier: null })).toEqual({
      used: 40,
      limit: 40,
      tier: null,
    });
  });

  it("reads a 409 body, which carries the same fields beside its error", () => {
    expect(
      readPeopleLimit({ error: "people_limit_reached", used: 6, limit: 6, tier: "gold" }),
    ).toEqual({ used: 6, limit: 6, tier: "gold" });
  });

  it("answers null for a payload without one, as an older API sends", () => {
    expect(readPeopleLimit(undefined)).toBeNull();
    expect(readPeopleLimit(null)).toBeNull();
    expect(readPeopleLimit({ error: "host_cap_reached" })).toBeNull();
  });

  it("answers null for a malformed one rather than guessing", () => {
    expect(readPeopleLimit({ used: "4", limit: 6, tier: "ivory" })).toBeNull();
    expect(readPeopleLimit({ used: 4, limit: -1, tier: "ivory" })).toBeNull();
    expect(readPeopleLimit({ used: 1.5, limit: 6, tier: "ivory" })).toBeNull();
    expect(readPeopleLimit({ used: 4, limit: 6, tier: "platinum" })).toBeNull();
    expect(readPeopleLimit({ used: 4, limit: 6 })).toBeNull();
  });
});

describe("atPeopleLimit", () => {
  it("is true at and over the limit, false under it", () => {
    expect(atPeopleLimit({ used: 5, limit: 6, tier: "ivory" })).toBe(false);
    expect(atPeopleLimit({ used: 6, limit: 6, tier: "gold" })).toBe(true);
    expect(atPeopleLimit({ used: 9, limit: 6, tier: "gold" })).toBe(true);
  });
});

describe("upgradeTierFor", () => {
  it("names the paid tier to offer, and nothing when no tier has room", () => {
    expect(upgradeTierFor({ used: 6, limit: 6, tier: "gold" })).toBe("gold");
    expect(upgradeTierFor({ used: 15, limit: 15, tier: "crimson" })).toBe("crimson");
    expect(upgradeTierFor({ used: 40, limit: 40, tier: null })).toBeNull();
  });

  it("offers nothing while the wedding has room", () => {
    expect(upgradeTierFor({ used: 2, limit: 15, tier: "gold" })).toBeNull();
  });
});

describe("peopleCountLabel", () => {
  it("reads as a count against the limit", () => {
    expect(peopleCountLabel({ used: 4, limit: 6, tier: "ivory" })).toBe("4 of 6 people");
    expect(peopleCountLabel({ used: 1, limit: 15, tier: "gold" })).toBe("1 of 15 people");
  });
});

describe("peopleLimitMessage", () => {
  it("names the limit and the tier that lifts it", () => {
    expect(peopleLimitMessage({ used: 6, limit: 6, tier: "gold" })).toBe(
      "This wedding has reached its plan's limit of 6 people. Remove someone, or upgrade to Gold.",
    );
  });

  it("says plainly when no plan holds more", () => {
    expect(peopleLimitMessage({ used: 40, limit: 40, tier: null })).toBe(
      "This wedding has reached its plan's limit of 40 people. No plan holds more, so remove someone first.",
    );
  });

  it("tells a wedding over its limit that everyone keeps their place, and how many to remove", () => {
    expect(peopleLimitMessage({ used: 10, limit: 6, tier: "gold" })).toBe(
      "This wedding has 10 people, more than its plan's limit of 6. Everyone keeps their place; to add someone, remove 5 or upgrade to Gold.",
    );
    expect(peopleLimitMessage({ used: 7, limit: 6, tier: "gold" })).toBe(
      "This wedding has 7 people, more than its plan's limit of 6. Everyone keeps their place; to add someone, remove 2 or upgrade to Gold.",
    );
  });

  it("names no upgrade for a wedding over the top tier's limit", () => {
    expect(peopleLimitMessage({ used: 41, limit: 40, tier: null })).toBe(
      "This wedding has 41 people, more than its plan's limit of 40. Everyone keeps their place; to add someone, remove 2 first.",
    );
  });
});
