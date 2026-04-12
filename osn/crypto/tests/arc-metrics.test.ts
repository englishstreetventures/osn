import { describe, expect, it } from "vitest";

import { ArcTokenError } from "../src/arc";
import { ARC_METRICS, classifyArcVerifyError } from "../src/arc-metrics";

/**
 * `classifyArcVerifyError` converts a caught exception thrown during ARC
 * token verification into one of the bounded `ArcVerifyResult` strings
 * used as a metric attribute. Pure, deterministic, table-driven.
 */
describe("classifyArcVerifyError", () => {
  it.each([
    [new Error("JWT expired"), "expired"],
    [new Error("Token has expired 5 minutes ago"), "expired"],
    [new Error("audience claim does not match"), "audience_mismatch"],
    [new Error("ARC token missing required scope: graph:write"), "scope_denied"],
    [new Error("Unknown service: rogue-app"), "unknown_issuer"],
    [new Error("ARC token missing scope claim"), "malformed"],
    [new Error("Invalid public key for pulse-api"), "unknown_issuer"],
  ])("maps %o → %s", (err, expected) => {
    expect(classifyArcVerifyError(err)).toBe(expected);
  });

  it("maps an ArcTokenError with an expired message to 'expired'", () => {
    const err = new ArcTokenError({ message: "Token has expired" });
    expect(classifyArcVerifyError(err)).toBe("expired");
  });

  it("falls back to 'bad_signature' for an unknown error message", () => {
    expect(classifyArcVerifyError(new Error("something weird"))).toBe("bad_signature");
  });

  it("falls back to 'bad_signature' for non-Error values", () => {
    expect(classifyArcVerifyError("oops")).toBe("bad_signature");
    expect(classifyArcVerifyError(null)).toBe("bad_signature");
    expect(classifyArcVerifyError(undefined)).toBe("bad_signature");
    expect(classifyArcVerifyError(42)).toBe("bad_signature");
  });
});

describe("ARC_METRICS naming", () => {
  it("all names follow the arc.* lowercase dotted convention", () => {
    const nameRe = /^arc\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const name of Object.values(ARC_METRICS)) {
      expect(name, `${name} does not match ${nameRe}`).toMatch(nameRe);
    }
  });

  it("every metric name is unique", () => {
    const values = Object.values(ARC_METRICS);
    expect(new Set(values).size).toBe(values.length);
  });
});
