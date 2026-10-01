import { describe, expect, it } from "vitest";

import { deletedWeddingsOf, restoreUntilLabel } from "../../src/lib/wedding-lifecycle";

describe("deletedWeddingsOf", () => {
  it("reads the list body's restorable weddings, and nothing from a body without them", () => {
    const deleted = [
      {
        id: "wed_a",
        slug: "a",
        displayName: "A",
        deletedAt: "2026-10-01T00:00:00.000Z",
        restoreUntil: "2026-10-08T00:00:00.000Z",
      },
    ];
    expect(deletedWeddingsOf({ weddings: [], deleted })).toEqual(deleted);
    expect(deletedWeddingsOf({ weddings: [] })).toEqual([]);
    expect(deletedWeddingsOf({ deleted: "nope" })).toEqual([]);
    expect(deletedWeddingsOf(null)).toEqual([]);
  });
});

describe("restoreUntilLabel", () => {
  it("names the day, and nothing for a date it cannot read", () => {
    expect(restoreUntilLabel("2026-10-08T00:00:00.000Z")).toMatch(/October 2026/);
    expect(restoreUntilLabel("not a date")).toBe("");
  });
});
