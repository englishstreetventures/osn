import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserTimeZone,
  canonicalTimeZone,
  describeTimeZone,
  timeZoneGroups,
  zoneOffset,
} from "./timezones";

/**
 * The timezone helpers behind the events drawer's zone dropdown (and the
 * settings panel's deadline zone). The load-bearing one is {@link zoneOffset}:
 * it replaces the hand-picked "UTC offset" select, so if it gets DST wrong the
 * editor writes a timestamp an hour off with nothing to catch it.
 */

describe("zoneOffset", () => {
  it("derives a southern-hemisphere summer offset", () => {
    // Sydney is on AEDT (+11:00) in November.
    expect(zoneOffset("Australia/Sydney", "2026-11-14", "15:00")).toBe("+11:00");
  });

  it("derives the same zone's winter offset — the reason it isn't a fixed pick", () => {
    // …and on AEST (+10:00) in July. One event list can straddle both.
    expect(zoneOffset("Australia/Sydney", "2026-07-14", "15:00")).toBe("+10:00");
  });

  it("handles a zone that never shifts", () => {
    expect(zoneOffset("Australia/Brisbane", "2026-11-14", "15:00")).toBe("+10:00");
    expect(zoneOffset("Australia/Brisbane", "2026-07-14", "15:00")).toBe("+10:00");
  });

  it("handles a half-hour zone", () => {
    expect(zoneOffset("Asia/Kolkata", "2026-11-14", "15:00")).toBe("+05:30");
  });

  it("handles a negative offset", () => {
    expect(zoneOffset("America/New_York", "2026-11-14", "15:00")).toBe("-05:00");
    expect(zoneOffset("America/New_York", "2026-07-14", "15:00")).toBe("-04:00");
  });

  it("renders zero as +00:00, not Z", () => {
    expect(zoneOffset("UTC", "2026-11-14", "15:00")).toBe("+00:00");
  });

  it("resolves the offset from the WALL-CLOCK time, not the naive UTC reading", () => {
    // 2026-04-05 03:00 in Sydney is after the DST end (02:00 → 03:00 became
    // 02:00 AEST), so it is +10:00. Reading the offset at the naive UTC instant
    // alone would land before the transition and answer +11:00.
    expect(zoneOffset("Australia/Sydney", "2026-04-05", "03:00")).toBe("+10:00");
  });

  it("returns null when the date or time is incomplete", () => {
    expect(zoneOffset("Australia/Sydney", "", "15:00")).toBeNull();
    expect(zoneOffset("Australia/Sydney", "2026-11-14", "")).toBeNull();
  });

  it("returns null for a blank or unresolvable zone, so a caller keeps what it had", () => {
    expect(zoneOffset("", "2026-11-14", "15:00")).toBeNull();
    expect(zoneOffset("Not/AZone", "2026-11-14", "15:00")).toBeNull();
  });

  it("refuses a FIXED-OFFSET pseudo-zone, which Intl would otherwise resolve", () => {
    // `Intl` accepts these, and a fixed offset never applies DST — answering
    // with one would silently reinstate, for imported data, the exact bug that
    // removing the offset picker was meant to end. Null instead, so the caller
    // keeps whatever offset the stored value already carried.
    expect(zoneOffset("+10:00", "2026-11-14", "15:00")).toBeNull();
    expect(zoneOffset("-05:00", "2026-11-14", "15:00")).toBeNull();
  });

  it("resolves an alternate spelling of a real zone", () => {
    expect(zoneOffset("AUSTRALIA/sydney", "2026-11-14", "15:00")).toBe("+11:00");
  });

  it("signs a NEGATIVE half-hour offset correctly", () => {
    // The Math.abs/Math.floor split in `formatOffsetMinutes` is where a sign
    // bug on a fractional negative offset would live.
    expect(zoneOffset("America/St_Johns", "2026-11-14", "15:00")).toBe("-03:30");
  });

  // The two-pass disambiguation's documented behaviour at a DST boundary, where
  // the wall time is ambiguous or non-existent and any answer is a choice. Both
  // cases put a real timestamp on the wire, and the two-pass logic is subtle
  // enough that a refactor to one or three passes would look correct and pass
  // everything else — so both are pinned.
  it("takes the LATER offset for the repeated hour at DST end", () => {
    // 2026-04-05 02:30 happens twice in Sydney (02:00 AEDT → 02:00 AEST). The
    // second occurrence wins, so the timestamp reads 02:30+10:00.
    expect(zoneOffset("Australia/Sydney", "2026-04-05", "02:30")).toBe("+10:00");
  });

  it("shifts the NON-EXISTENT hour at DST start forward, rather than failing", () => {
    // 2026-10-04 02:30 never occurs in Sydney (02:00 AEST → 03:00 AEDT). The
    // answer is `+10:00`, which looks like the pre-shift offset but denotes
    // 2026-10-03T16:30Z — i.e. 03:30 AEDT, the instant Temporal's `compatible`
    // disambiguation picks by moving a gap time forward. The wall clock the
    // organiser typed is spelled with the offset that makes it name a real
    // instant; it is not silently dropped and it is not an hour out.
    expect(zoneOffset("Australia/Sydney", "2026-10-04", "02:30")).toBe("+10:00");
    expect(new Date("2026-10-04T02:30:00+10:00").toISOString()).toBe("2026-10-03T16:30:00.000Z");
  });
});

describe("canonicalTimeZone", () => {
  it("collapses casing and aliases to the tz database's own spelling", () => {
    expect(canonicalTimeZone("AUSTRALIA/sydney")).toBe("Australia/Sydney");
    expect(canonicalTimeZone("utc")).toBe("UTC");
    expect(canonicalTimeZone("Australia/Sydney")).toBe("Australia/Sydney");
  });

  it("is idempotent", () => {
    const once = canonicalTimeZone("AUSTRALIA/sydney")!;
    expect(canonicalTimeZone(once)).toBe(once);
  });

  it("rejects fixed-offset forms and anything Intl can't resolve", () => {
    for (const zone of ["+05:30", "-14:00", "Not/AZone", "", "Mars/Olympus_Mons"]) {
      expect(canonicalTimeZone(zone)).toBeNull();
    }
  });
});

describe("timeZoneGroups", () => {
  it("groups zones by region, sorted", () => {
    const groups = timeZoneGroups();
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.map((g) => g.label)).toEqual(groups.map((g) => g.label).toSorted());
    const australia = groups.find((g) => g.label === "Australia");
    expect(australia?.zones).toContain("Australia/Sydney");
  });

  it("offers no zone twice", () => {
    const all = timeZoneGroups().flatMap((g) => g.zones);
    expect(new Set(all).size).toBe(all.length);
  });

  it("leads with an unknown current value, so a <select> can't silently re-home it", () => {
    // A `<select>` whose value matches no option shows the FIRST option instead
    // — an imported zone this tz database doesn't know would look like the
    // portal had moved the wedding to another continent.
    const groups = timeZoneGroups("Mars/Olympus_Mons");
    expect(groups[0]).toEqual({ label: "Current", zones: ["Mars/Olympus_Mons"] });
  });

  it("does not duplicate a current value the database already knows", () => {
    const groups = timeZoneGroups("Australia/Sydney");
    expect(groups[0]?.label).not.toBe("Current");
    expect(groups.flatMap((g) => g.zones).filter((z) => z === "Australia/Sydney")).toHaveLength(1);
  });

  it("returns the SAME array identity for every known zone (P-W1)", () => {
    // `<For>` reconciles by item reference. A fresh array of fresh group
    // objects per call meant one zone change tore down and rebuilt ~900
    // option nodes — and replacing every `<option>` under a `<select>` is also
    // how the element loses the selection it was just given.
    const a = timeZoneGroups("Australia/Sydney");
    const b = timeZoneGroups("Europe/London");
    const c = timeZoneGroups();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(b[0]).toBe(a[0]);
  });

  it("keeps the shared groups intact when it has to prepend an unknown current", () => {
    const known = timeZoneGroups("Australia/Sydney");
    const unknown = timeZoneGroups("Mars/Olympus_Mons");
    expect(unknown).not.toBe(known);
    // Only the prefix is new — the region groups are still the shared objects.
    expect(unknown.slice(1)).toEqual(known);
    expect(unknown[1]).toBe(known[0]);
  });
});

describe("timeZoneGroups — runtime without Intl.supportedValuesOf", () => {
  // The fallback list exists so the dropdown is never empty on a runtime that
  // can't enumerate its tz database. Module-level caching means a dynamic
  // re-import is the only way to reach it.
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("falls back to a curated list rather than rendering no options", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "Intl",
      Object.assign(Object.create(null), globalThis.Intl, { supportedValuesOf: undefined }),
    );
    const { timeZoneGroups: fallbackGroups } = await import("./timezones");

    const groups = fallbackGroups();
    const zones = groups.flatMap((g) => g.zones);
    expect(zones.length).toBeGreaterThan(0);
    expect(zones).toContain("Australia/Sydney");
    expect(zones).toContain("America/New_York");
    // A slash-less zone gets a heading of its own rather than an empty one.
    expect(groups.find((g) => g.label === "UTC")?.zones).toEqual(["UTC"]);
  });

  it("also falls back when the enumeration throws", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "Intl",
      Object.assign(Object.create(null), globalThis.Intl, {
        supportedValuesOf: () => {
          throw new Error("nope");
        },
      }),
    );
    const { timeZoneGroups: fallbackGroups } = await import("./timezones");
    expect(fallbackGroups().flatMap((g) => g.zones)).toContain("Australia/Sydney");
  });
});

describe("browserTimeZone / describeTimeZone", () => {
  it("names a zone the runtime resolves", () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });

  it("appends the abbreviation for the day in question", () => {
    expect(describeTimeZone("Australia/Sydney", "2026-11-14")).toBe("Australia/Sydney (AEDT)");
    expect(describeTimeZone("Australia/Sydney", "2026-07-14")).toBe("Australia/Sydney (AEST)");
  });

  it("falls back to the bare zone when it can't be resolved", () => {
    expect(describeTimeZone("Not/AZone", "2026-11-14")).toBe("Not/AZone");
  });
});
