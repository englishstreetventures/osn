import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";

import { StartUpgradeSessionBody } from "../../src/schemas/upgrade";

const decode = (v: unknown) =>
  Effect.runSync(Effect.result(Schema.decodeUnknownEffect(StartUpgradeSessionBody)(v)));

describe("StartUpgradeSessionBody", () => {
  it("admits the two paid tiers", () => {
    expect(decode({ tier: "gold" })._tag).toBe("Success");
    expect(decode({ tier: "crimson", module: "vendors" })._tag).toBe("Success");
  });

  it("refuses the free tier and the legacy per-module keys, which are not for sale", () => {
    for (const tier of ["ivory", "vendors", "registry", "capacity_500", "premium_templates"]) {
      expect(decode({ tier })._tag, tier).toBe("Failure");
    }
  });

  it("does not admit an inherited Object property as a tier", () => {
    // A membership test that walks the prototype chain would say yes here.
    for (const tier of ["constructor", "toString", "__proto__"]) {
      expect(decode({ tier })._tag, tier).toBe("Failure");
    }
  });

  it("refuses a missing or non-string tier", () => {
    expect(decode({})._tag).toBe("Failure");
    expect(decode({ tier: null })._tag).toBe("Failure");
    expect(decode({ tier: ["gold"] })._tag).toBe("Failure");
    expect(decode(null)._tag).toBe("Failure");
  });

  it("bounds module to a short string", () => {
    expect(decode({ tier: "gold", module: "m".repeat(32) })._tag).toBe("Success");
    expect(decode({ tier: "gold", module: "m".repeat(33) })._tag).toBe("Failure");
    expect(decode({ tier: "gold", module: 42 })._tag).toBe("Failure");
  });
});
