import { describe, expect, it } from "vitest";

import { joinIso, splitIso } from "./event-datetime";

/**
 * The drawer's date+time+offset composer. A stored ISO timestamp round-trips
 * losslessly through split → join, and a blank/incomplete value collapses to ""
 * (the parser's "no stated end" sentinel + the validator's "required" trigger).
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

  it("collapses to '' when the date or time is missing", () => {
    expect(joinIso({ date: "", time: "15:00", offset: "+11:00" })).toBe("");
    expect(joinIso({ date: "2026-11-14", time: "", offset: "+11:00" })).toBe("");
  });

  it("round-trips split → join for a full value", () => {
    const iso = "2026-11-14T18:00:00+10:00";
    expect(joinIso(splitIso(iso))).toBe(iso);
  });
});
