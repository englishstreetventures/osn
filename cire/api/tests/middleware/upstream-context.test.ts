import { describe, expect, it } from "bun:test";

import {
  hasWeddingGateError,
  readOsnProfileId,
  readWeddingTier,
} from "../../src/middleware/upstream-context";

/**
 * Readers for values an upstream plugin parked on the context. Each answers
 * `undefined` (or `false`) for anything absent or of the wrong shape, which is
 * what every fail-closed branch behind them denies on — so a reader that
 * passed a wrong value through would open a gate.
 */

describe("readWeddingTier", () => {
  it("returns a known tier", () => {
    expect(readWeddingTier({ weddingTier: "ivory" })).toBe("ivory");
    expect(readWeddingTier({ weddingTier: "gold" })).toBe("gold");
    expect(readWeddingTier({ weddingTier: "crimson" })).toBe("crimson");
  });

  it("returns undefined for a value that is not a tier", () => {
    for (const weddingTier of ["platinum", "GOLD", "", 2, null, undefined, { tier: "gold" }]) {
      expect(readWeddingTier({ weddingTier }), String(weddingTier)).toBeUndefined();
    }
  });

  it("returns undefined when no gate parked one, or there is no context", () => {
    expect(readWeddingTier({})).toBeUndefined();
    expect(readWeddingTier(null)).toBeUndefined();
    expect(readWeddingTier(undefined)).toBeUndefined();
    expect(readWeddingTier("gold")).toBeUndefined();
  });
});

describe("readOsnProfileId", () => {
  it("returns a string id and nothing else", () => {
    expect(readOsnProfileId({ osnProfileId: "usr_a" })).toBe("usr_a");
    expect(readOsnProfileId({ osnProfileId: 7 })).toBeUndefined();
    expect(readOsnProfileId({})).toBeUndefined();
    expect(readOsnProfileId(null)).toBeUndefined();
  });
});

describe("hasWeddingGateError", () => {
  it("is true only when a gate parked an error", () => {
    expect(hasWeddingGateError({ weddingGateError: { status: 403 } })).toBe(true);
    expect(hasWeddingGateError({ weddingGateError: undefined })).toBe(false);
    expect(hasWeddingGateError({})).toBe(false);
    expect(hasWeddingGateError(null)).toBe(false);
  });
});
