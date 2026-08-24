import { describe, expect, it } from "vitest";

import { clientNameSkeleton } from "../../../src/services/auth/oidc";

/**
 * S-L3 (`xchromo/osn-tracker#441`). `clientNameSkeleton` folds each character through
 * `CONFUSABLE_FOLD` via `Object.hasOwn`, not the `in` operator — `in` walks
 * the prototype chain, so a name containing a character that only exists as
 * an *inherited* `Object.prototype` property would have folded through that
 * inherited value instead of being left alone and dropped.
 *
 * There is no such collision under normal `Object.prototype` (its own member
 * names are multi-character, and this fold runs one code point at a time), so
 * the test pollutes the prototype itself with a single-character property to
 * prove the guard checks OWN membership rather than trusting on that absence.
 */
describe("clientNameSkeleton", () => {
  it("does not fold a character that is only an inherited property", () => {
    const proto = Object.prototype as Record<string, string>;
    // "δ" (Greek delta) is not a key CONFUSABLE_FOLD owns.
    expect(Object.hasOwn(proto, "δ")).toBe(false);
    // Non-enumerable, so no `for...in` anywhere in the realm can see it while
    // the test holds it. Removed again in the `finally`.
    Object.defineProperty(proto, "δ", {
      value: "z",
      configurable: true,
      enumerable: false,
      writable: true,
    });
    try {
      // With `in`, "δ" would resolve through the prototype chain and fold to
      // "z". With `Object.hasOwn`, it stays unrecognised and is dropped by
      // the trailing `[^a-z]` strip.
      expect(clientNameSkeleton("aδb")).toBe("ab");
    } finally {
      delete proto.δ;
    }
  });
});
