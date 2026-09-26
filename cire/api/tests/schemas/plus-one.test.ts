import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  GuestPlusOnePermissionBody,
  HouseholdPlusOnePermissionBody,
  PLUS_ONE_NAME_MAX,
  PlusOneNameBody,
} from "../../src/schemas/plus-one";

const dec = <A>(s: Schema.Codec<A>, v: unknown) => Schema.decodeUnknownResult(s)(v);
const tag = (v: unknown) => dec(PlusOneNameBody, v)._tag;

/**
 * A plus-one's name is typed by a guest and read by the couple — in the portal,
 * in change warnings and in CSVs — so the body refuses what would mislead them:
 * a name past the bound, a blank first name, and the characters that are not
 * visible or that reorder the text around them. Each range is tested at both
 * ends and just past them.
 */
describe("PlusOneNameBody", () => {
  it("accepts a name at the bound on each half, and refuses one past it", () => {
    const at = "x".repeat(PLUS_ONE_NAME_MAX);
    const past = "x".repeat(PLUS_ONE_NAME_MAX + 1);
    expect(tag({ firstName: at, lastName: at })).toBe("Success");
    expect(tag({ firstName: past })).toBe("Failure");
    expect(tag({ firstName: "Sam", lastName: past })).toBe("Failure");
  });

  it("refuses a blank first name, and allows an empty last name", () => {
    expect(tag({ firstName: "" })).toBe("Failure");
    expect(tag({ firstName: " \t " })).toBe("Failure");
    expect(tag({ firstName: "Sam", lastName: "" })).toBe("Success");
  });

  it("defaults the last name to empty", () => {
    const result = dec(PlusOneNameBody, { firstName: "Sam" });
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.success.lastName).toBe("");
  });

  it("refuses control, format and separator characters, on both halves", () => {
    for (const code of [
      0x00,
      0x09,
      0x1f,
      0x7f,
      0x9f, // controls
      0xad,
      0x200b,
      0x200e,
      0x200f,
      0x061c,
      0xfeff, // soft hyphen, zero-width, direction marks, BOM
      0x202a,
      0x202e,
      0x2066,
      0x2069,
      0x206a, // overrides and isolates
      0x2028,
      0x2029, // line and paragraph separators
      0x115f,
      0x1160,
      0x3164,
      0xffa0,
      0x2800, // letters that render blank
    ]) {
      const char = String.fromCodePoint(code);
      expect(tag({ firstName: `Sam${char}X` })).toBe("Failure");
      expect(tag({ firstName: "Sam", lastName: `Guest${char}X` })).toBe("Failure");
    }
  });

  it("refuses a first name that shows nothing, however it is made", () => {
    for (const blank of ["\u200b", "\u3164", "\u2800", " \u00a0 ", "-", "'"]) {
      expect(tag({ firstName: blank })).toBe("Failure");
    }
  });

  it("accepts spaces, the joiners, and names in any script", () => {
    for (const code of [0x20, 0xa0, 0x202f]) {
      expect(tag({ firstName: `Sam${String.fromCodePoint(code)}x` })).toBe("Success");
    }
    // The zero-width joiner and non-joiner some scripts and emoji need.
    expect(tag({ firstName: "\u0915\u094d\u200d\u0937", lastName: "\u0645\u200c\u06cc" })).toBe(
      "Success",
    );
    expect(tag({ firstName: "Zoë", lastName: "Nguyễn-Ōkubo" })).toBe("Success");
    expect(tag({ firstName: "अनन्या", lastName: "राव" })).toBe("Success");
    expect(tag({ firstName: "O'Brien", lastName: "de la Cruz" })).toBe("Success");
  });

  it("refuses a non-string name", () => {
    expect(tag({ firstName: 7 })).toBe("Failure");
    expect(tag({ firstName: "Sam", lastName: null })).toBe("Failure");
  });
});

describe("the permission bodies", () => {
  it("default the remove flag to false", () => {
    const guest = dec(GuestPlusOnePermissionBody, { allowed: false });
    const household = dec(HouseholdPlusOnePermissionBody, { allowed: false });
    expect(guest._tag === "Success" && guest.success.removePlusOne).toBe(false);
    expect(household._tag === "Success" && household.success.removePlusOnes).toBe(false);
  });

  it("refuse a missing or non-boolean `allowed`, and a non-boolean flag", () => {
    for (const body of [
      {},
      { allowed: "true" },
      { allowed: 1 },
      { allowed: true, removePlusOne: "yes" },
    ]) {
      expect(dec(GuestPlusOnePermissionBody, body)._tag).toBe("Failure");
    }
    for (const body of [{}, { allowed: "true" }, { allowed: false, removePlusOnes: 1 }]) {
      expect(dec(HouseholdPlusOnePermissionBody, body)._tag).toBe("Failure");
    }
  });
});
