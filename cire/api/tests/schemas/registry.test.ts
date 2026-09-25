import { describe, expect, it } from "bun:test";

import { Effect, Result, Schema } from "effect";

import { UpdateRegistrySettingsBody } from "../../src/schemas/registry";

const decode = (v: unknown) =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(UpdateRegistrySettingsBody)(v)));

describe("UpdateRegistrySettingsBody", () => {
  it("accepts a patch with the values its caller saw", () => {
    const out = decode({
      published: true,
      headline: "Gifts",
      expected: { published: false, headline: null },
    });
    expect(Result.isSuccess(out)).toBe(true);
  });

  it("accepts an empty patch and a patch with no expectations", () => {
    expect(Result.isSuccess(decode({}))).toBe(true);
    expect(Result.isSuccess(decode({ message: "No boxes" }))).toBe(true);
  });

  it("refuses an `expected` that is not an object of settings fields", () => {
    // Each of these would otherwise reach the SQL comparison and come back as a
    // conflict or a 500 rather than as the caller's own mistake.
    for (const body of [
      { expected: "x" },
      { published: true, expected: { published: "yes" } },
      { headline: "Gifts", expected: { headline: "x".repeat(10_000) } },
      { shippingVisibleFrom: null, expected: { shippingVisibleFrom: "next week" } },
    ]) {
      expect(Result.isFailure(decode(body))).toBe(true);
    }
  });
});
