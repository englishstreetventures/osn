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

  it("refuses both ends of every hidden range, on both halves", () => {
    for (const code of [0x00, 0x09, 0x1f, 0x7f, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069]) {
      const char = String.fromCodePoint(code);
      expect(tag({ firstName: `Sam${char}` })).toBe("Failure");
      expect(tag({ firstName: "Sam", lastName: `Guest${char}` })).toBe("Failure");
    }
  });

  it("accepts the code points just past each range", () => {
    for (const code of [0x20, 0xa0, 0x2029, 0x202f, 0x2065, 0x206a]) {
      expect(tag({ firstName: `Sam${String.fromCodePoint(code)}x` })).toBe("Success");
    }
    // Names in any script pass.
    expect(tag({ firstName: "Zoë", lastName: "Nguyễn-Ōkubo" })).toBe("Success");
    expect(tag({ firstName: "अनन्या", lastName: "राव" })).toBe("Success");
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
