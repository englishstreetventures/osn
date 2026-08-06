import { describe, expect, it } from "vitest";

import { isDateOnly, joinIso, splitIso } from "./event-datetime";

/**
 * The drawer's date+time composer. A stored ISO timestamp round-trips losslessly
 * through split → join; a value with no date at all collapses to "" (the
 * parser's "no stated end" sentinel + the validator's "required" trigger); and a
 * date with no time survives as the bare date — the partial that keeps the date
 * picker from looking broken on a fresh event (see the module header).
 */

describe("event-datetime", () => {
  it("splits a full ISO-with-seconds offset value", () => {
    expect(splitIso("2026-11-14T15:00:00+11:00")).toEqual({
      date: "2026-11-14",
      time: "15:00",
      offset: "+11:00",
    });
  });

  it("splits a value with no seconds", () => {
    expect(splitIso("2026-11-14T15:00+11:00")).toEqual({
      date: "2026-11-14",
      time: "15:00",
      offset: "+11:00",
    });
  });

  it("normalises a compact offset (+1100 → +11:00)", () => {
    expect(splitIso("2026-11-14T15:00+1100").offset).toBe("+11:00");
  });

  it("splits a Z (UTC) value", () => {
    expect(splitIso("2026-11-14T15:00:00Z")).toEqual({
      date: "2026-11-14",
      time: "15:00",
      offset: "Z",
    });
  });

  it("yields empty parts for a blank / malformed value", () => {
    expect(splitIso("")).toEqual({ date: "", time: "", offset: "+00:00" });
    expect(splitIso("next tuesday")).toEqual({ date: "", time: "", offset: "+00:00" });
  });

  it("joins parts into the canonical seconds-padded shape", () => {
    expect(joinIso({ date: "2026-11-14", time: "15:00", offset: "+11:00" })).toBe(
      "2026-11-14T15:00:00+11:00",
    );
  });

  it("joins a Z offset", () => {
    expect(joinIso({ date: "2026-11-14", time: "09:30", offset: "Z" })).toBe(
      "2026-11-14T09:30:00Z",
    );
  });

  it("collapses to '' when there is no date", () => {
    expect(joinIso({ date: "", time: "15:00", offset: "+11:00" })).toBe("");
    expect(joinIso({ date: "   ", time: "", offset: "+11:00" })).toBe("");
  });

  it("keeps a picked date that has no time yet, as a bare date", () => {
    // The whole point: the drawer reads the date back out of what it just
    // wrote, so a join that dropped this would make the picker a no-op on any
    // event whose time is still blank — i.e. every newly-added event.
    expect(joinIso({ date: "2026-11-14", time: "", offset: "+11:00" })).toBe("2026-11-14");
  });

  it("splits that partial back out, so the picker shows the day again", () => {
    expect(splitIso("2026-11-14")).toEqual({ date: "2026-11-14", time: "", offset: "+00:00" });
  });

  it("round-trips split → join for a full value", () => {
    const iso = "2026-11-14T18:00:00+10:00";
    expect(joinIso(splitIso(iso))).toBe(iso);
  });

  it("round-trips split → join for a date-only partial", () => {
    expect(joinIso(splitIso("2026-11-14"))).toBe("2026-11-14");
  });

  it("recognises the date-only partial, and nothing else", () => {
    expect(isDateOnly("2026-11-14")).toBe(true);
    expect(isDateOnly("  2026-11-14 ")).toBe(true);
    expect(isDateOnly("2026-11-14T15:00:00+11:00")).toBe(false);
    expect(isDateOnly("")).toBe(false);
    expect(isDateOnly("next tuesday")).toBe(false);
  });
});
