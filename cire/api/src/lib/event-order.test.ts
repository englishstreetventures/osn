import { describe, it, expect } from "bun:test";

import { compareEventsByStart } from "./event-order";
import type { EventOrderKey } from "./event-order";

const ev = (id: string, startAt: string, sortOrder = 0): EventOrderKey => ({
  id,
  startAt,
  sortOrder,
});

describe("compareEventsByStart", () => {
  it("orders by parsed epoch, not lexicographically (offsets diverge)", () => {
    // Lexicographic order would put the 09:00+11:00 string first, but it is the
    // LATER instant (22:00Z vs 10:00Z).
    const early = ev("b", "2026-11-25T21:00:00+11:00"); // 10:00Z
    const late = ev("a", "2026-11-25T09:00:00-13:00"); // 22:00Z
    expect([late, early].toSorted(compareEventsByStart).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("sorts an unparseable start_at after every valid timestamp", () => {
    const valid = ev("valid", "2026-10-31T10:00:00+11:00");
    const broken = ev("broken", "not-a-date");
    expect([broken, valid].toSorted(compareEventsByStart).map((e) => e.id)).toEqual([
      "valid",
      "broken",
    ]);
    expect(compareEventsByStart(broken, valid)).toBeGreaterThan(0);
    expect(compareEventsByStart(valid, broken)).toBeLessThan(0);
  });

  it("falls back to sortOrder on equal instants", () => {
    const a = ev("a", "2026-10-31T10:00:00+11:00", 2);
    const b = ev("b", "2026-10-30T23:00:00Z", 1); // same instant, lower sortOrder
    expect([a, b].toSorted(compareEventsByStart).map((e) => e.id)).toEqual(["b", "a"]);
  });

  it("falls back to id on equal instant + sortOrder (deterministic)", () => {
    const a = ev("evt_a", "2026-10-31T10:00:00+11:00", 1);
    const b = ev("evt_b", "2026-10-31T10:00:00+11:00", 1);
    expect([b, a].toSorted(compareEventsByStart).map((e) => e.id)).toEqual(["evt_a", "evt_b"]);
    expect(compareEventsByStart(a, a)).toBe(0);
  });
});
