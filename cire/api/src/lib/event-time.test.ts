import { describe, it, expect } from "bun:test";

import {
  formatWallTime,
  isKnownTimeZone,
  parseWallTime,
  stampEventOffset,
  zoneOffsetAt,
} from "./event-time";

/**
 * An event's time is a wall clock + an IANA zone. These pin the three moves that
 * make that true on the sheet path: reading the local clock out of a cell
 * (ignoring anything the cell says about offsets), deriving the zone's offset for
 * that particular date, and stripping it back off again for an export.
 */

describe("parseWallTime", () => {
  it("reads the local date + time, with or without seconds", () => {
    expect(parseWallTime("2026-11-14T15:00")).toEqual({
      date: "2026-11-14",
      time: "15:00",
      seconds: "00",
    });
    expect(parseWallTime("2026-11-14T15:00:30")).toEqual({
      date: "2026-11-14",
      time: "15:00",
      seconds: "30",
    });
  });

  it("DISCARDS any offset in the cell — the Timezone column is authoritative", () => {
    const wall = { date: "2026-11-14", time: "15:00", seconds: "00" };
    expect(parseWallTime("2026-11-14T15:00+11:00")).toEqual(wall);
    expect(parseWallTime("2026-11-14T15:00:00+1100")).toEqual(wall);
    // Even a `Z`: three o'clock is three o'clock on the clock the zone names.
    expect(parseWallTime("2026-11-14T15:00:00Z")).toEqual(wall);
  });

  it("rejects free text, impossible readings, and anything with a tail", () => {
    for (const bad of [
      "",
      "TBD",
      "1st Nov 2026",
      "18/09/2026 4pm",
      "2026-13-40T99:99",
      "2026-11-14", // date-only: the editor's half-filled draft, not a timestamp
      "2026-11-14T15:00 GMT",
    ]) {
      expect(parseWallTime(bad)).toBeNull();
    }
  });

  it("accepts an over-long day, as the rule it replaced always did", () => {
    // `Date` rolls 31 February into 3 March rather than rejecting it, so this
    // gets through — exactly as it did under the old `isIsoTimestamp`. Left
    // alone deliberately: the events editor can't produce one (its picker walks
    // a real calendar), and tightening it here would start rejecting sheets that
    // import today, which is a bigger change than this one is making.
    expect(parseWallTime("2026-02-31T10:00")).toEqual({
      date: "2026-02-31",
      time: "10:00",
      seconds: "00",
    });
  });
});

describe("isKnownTimeZone", () => {
  it("accepts real IANA zones, including uncommon casing", () => {
    for (const zone of ["Australia/Sydney", "UTC", "Asia/Kolkata", "australia/sydney"]) {
      expect(isKnownTimeZone(zone)).toBe(true);
    }
  });

  it("rejects abbreviations, bare cities and fixed offsets — the exact things", () => {
    for (const bad of ["AEST", "Sydney", "Australia/Nowhere", "+10:00", "UTC+10"]) {
      expect(isKnownTimeZone(bad)).toBe(false);
    }
  });

  it("is stable across repeated calls (P-C1: memoized, but must stay correct)", () => {
    // Not a call-count assertion (that would pin an implementation detail) —
    // this pins the OUTCOME the cache must never break: hammering the same
    // zone repeatedly, and interleaving a rejection between hits, can't flip
    // a cached answer or leak across keys.
    for (let i = 0; i < 5; i++) {
      expect(isKnownTimeZone("Australia/Sydney")).toBe(true);
      expect(isKnownTimeZone("Not/AZone")).toBe(false);
    }
    expect(zoneOffsetAt("Australia/Sydney", "2026-11-14", "15:00")).toBe("+11:00");
  });
});

describe("zoneOffsetAt", () => {
  it("answers for the event's OWN date, not for today", () => {
    // The bug this model exists to prevent: one zone, two offsets, and no way
    // for a typed number to be right about both.
    expect(zoneOffsetAt("Australia/Sydney", "2026-11-14", "15:00")).toBe("+11:00");
    expect(zoneOffsetAt("Australia/Sydney", "2026-07-14", "15:00")).toBe("+10:00");
  });

  it("handles half-hour zones and negative offsets", () => {
    expect(zoneOffsetAt("Asia/Kolkata", "2026-11-14", "15:00")).toBe("+05:30");
    expect(zoneOffsetAt("America/New_York", "2026-11-14", "15:00")).toBe("-05:00");
    expect(zoneOffsetAt("UTC", "2026-11-14", "15:00")).toBe("+00:00");
  });

  it("refuses a fixed-offset pseudo-zone, which would be DST-blind all year", () => {
    for (const bad of ["+10:00", "UTC+10", "AEST", "Australia/Nowhere"]) {
      expect(zoneOffsetAt(bad, "2026-11-14", "15:00")).toBeNull();
    }
  });

  it("resolves a DST transition the way Temporal's `compatible` mode does", () => {
    // Sydney springs forward 2026-10-04 02:00 → 03:00.
    // A NON-EXISTENT wall time takes the pre-transition offset, so the clock the
    // organiser typed denotes a real instant just past the gap.
    expect(zoneOffsetAt("Australia/Sydney", "2026-10-04", "02:30")).toBe("+10:00");
    // A REPEATED hour (falls back 2027-04-04 03:00 → 02:00) takes the SECOND
    // occurrence.
    expect(zoneOffsetAt("Australia/Sydney", "2027-04-04", "02:30")).toBe("+10:00");
  });
});

describe("stampEventOffset", () => {
  it("turns a local time + a zone into the canonical stored timestamp", () => {
    expect(stampEventOffset("2026-11-14T15:00", "Australia/Sydney")).toBe(
      "2026-11-14T15:00:00+11:00",
    );
    expect(stampEventOffset("2026-07-14T15:00", "Australia/Sydney")).toBe(
      "2026-07-14T15:00:00+10:00",
    );
  });

  it("corrects an offset the cell got wrong, without moving the wall clock", () => {
    // +10:00 is Sydney's winter offset — wrong for November. 3pm stays 3pm.
    expect(stampEventOffset("2026-11-14T15:00:00+10:00", "Australia/Sydney")).toBe(
      "2026-11-14T15:00:00+11:00",
    );
  });

  it("keeps seconds, so a full-fidelity round trip is byte-stable", () => {
    expect(stampEventOffset("2026-11-14T15:00:30", "Australia/Sydney")).toBe(
      "2026-11-14T15:00:30+11:00",
    );
  });

  it("passes a blank through as the '' no-stated-end sentinel", () => {
    expect(stampEventOffset("", "Australia/Sydney")).toBe("");
    expect(stampEventOffset("   ", "Australia/Sydney")).toBe("");
  });

  it("leaves a value it can't stamp exactly as it found it", () => {
    // Both are rejected by the front doors before they get here; mangling one
    // would be worse than storing what was actually given.
    expect(stampEventOffset("TBD", "Australia/Sydney")).toBe("TBD");
    expect(stampEventOffset("2026-11-14T15:00", "AEST")).toBe("2026-11-14T15:00");
  });
});

describe("formatWallTime", () => {
  it("strips the derived offset back off for an export", () => {
    expect(formatWallTime("2026-11-14T15:00:00+11:00")).toBe("2026-11-14T15:00");
    expect(formatWallTime("2026-11-14T15:00:00Z")).toBe("2026-11-14T15:00");
    expect(formatWallTime("")).toBe("");
  });

  it("keeps seconds only when they carry information", () => {
    expect(formatWallTime("2026-11-14T15:00:30+11:00")).toBe("2026-11-14T15:00:30");
  });

  it("round-trips through stampEventOffset", () => {
    const stored = "2026-11-14T15:00:00+11:00";
    expect(stampEventOffset(formatWallTime(stored), "Australia/Sydney")).toBe(stored);
  });

  it("shows a non-timestamp verbatim — an export must not lie about what's stored", () => {
    expect(formatWallTime("TBD")).toBe("TBD");
  });
});
