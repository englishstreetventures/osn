import { describe, it, expect } from "bun:test";

import { constantTimeEqual } from "./timing";

describe("constantTimeEqual", () => {
  it("returns true for identical strings", () => {
    expect(constantTimeEqual("hunter2", "hunter2")).toBe(true);
  });

  it("returns false for length-equal but different strings", () => {
    expect(constantTimeEqual("hunter2", "hunter3")).toBe(false);
  });

  it("returns false for length-mismatched strings", () => {
    expect(constantTimeEqual("hunter2", "hunter22")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
  });

  it("returns true for two empty strings", () => {
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns the same boolean shape for length-equal inputs regardless of mismatch position", () => {
    // Mostly a smoke test that the function is total — the timing claim itself
    // can't be asserted from JS-land, but the caller wants a "same bool across
    // length-equal inputs" sanity check.
    const a = "abcdefgh";
    expect(typeof constantTimeEqual(a, "abcdefgh")).toBe("boolean");
    expect(typeof constantTimeEqual(a, "Xbcdefgh")).toBe("boolean");
    expect(typeof constantTimeEqual(a, "abcdefgX")).toBe("boolean");
  });
});
