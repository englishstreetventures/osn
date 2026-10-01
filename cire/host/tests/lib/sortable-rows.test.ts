import { describe, expect, it } from "vitest";

import { sameButOrder } from "../../src/lib/sortable-rows";

/** Loose, so a test can add or swap keys the way a changed API shape would. */
type Row = { sortOrder: number } & Record<string, unknown>;

describe("sameButOrder", () => {
  const row: Row = { id: "a", title: "Pan", sortOrder: 3 };

  it("treats a sortOrder-only change as the same row", () => {
    expect(sameButOrder(row, { ...row, sortOrder: 1 })).toBe(true);
    expect(sameButOrder(row, row)).toBe(true);
  });

  it("treats any other change as a new row", () => {
    expect(sameButOrder(row, { ...row, title: "Kettle" })).toBe(false);
    expect(sameButOrder(row, { ...row, sortOrder: 1, title: "Kettle" })).toBe(false);
  });

  it("compares by reference, so a nested value replaced by an equal copy is a change", () => {
    const withTags: Row = { ...row, tags: ["x"] };
    expect(sameButOrder(withTags, { ...withTags, tags: ["x"] })).toBe(false);
  });

  it("notices a key added or swapped for another", () => {
    expect(sameButOrder(row, { ...row, note: "n" })).toBe(false);
    const { title: _title, ...rest } = row;
    expect(sameButOrder(row, { ...rest, name: "Pan" })).toBe(false);
  });

  it("equals undefined only to undefined", () => {
    expect(sameButOrder(undefined, undefined)).toBe(true);
    expect(sameButOrder(row, undefined)).toBe(false);
    expect(sameButOrder(undefined, row)).toBe(false);
  });
});
