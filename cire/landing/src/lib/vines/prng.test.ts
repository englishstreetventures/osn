import { afterEach, describe, expect, it, vi } from "vitest";

import { smoothPath, vec } from "./geometry";
import { makeRng, randomSeed } from "./prng";

describe("makeRng", () => {
  it("is deterministic for a given seed (server/client parity)", () => {
    const a = makeRng("amara-and-sam");
    const b = makeRng("amara-and-sam");
    const seqA = Array.from({ length: 8 }, () => a.next());
    const seqB = Array.from({ length: 8 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it("diverges for different seeds", () => {
    const a = Array.from({ length: 8 }, makeRng("seed-one").next);
    const b = Array.from({ length: 8 }, makeRng("seed-two").next);
    expect(a).not.toEqual(b);
  });

  it("produces floats in [0,1) and respects range/int bounds", () => {
    const r = makeRng("bounds");
    for (let i = 0; i < 500; i++) {
      const f = r.next();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const ranged = r.range(2, 5);
      expect(ranged).toBeGreaterThanOrEqual(2);
      expect(ranged).toBeLessThan(5);
      const i2 = r.int(1, 4);
      expect(i2).toBeGreaterThanOrEqual(1);
      expect(i2).toBeLessThanOrEqual(4);
      expect(Number.isInteger(i2)).toBe(true);
    }
  });
});

describe("randomSeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns a non-empty url-safe string when crypto is available", () => {
    const s = randomSeed();
    expect(typeof s).toBe("string");
    expect(s.length).toBeGreaterThan(0);
    expect(s).toMatch(/^[a-z0-9]+$/);
  });

  it("falls back to the static constant when crypto is unavailable", () => {
    vi.stubGlobal("crypto", undefined);
    expect(randomSeed()).toBe("cire-static-seed");
  });
});

describe("smoothPath", () => {
  it("starts with a moveto at the first point and ends at the last point", () => {
    const pts = [vec(0, 0), vec(10, 20), vec(30, 25), vec(40, 60)];
    const d = smoothPath(pts);
    expect(d.startsWith("M 0 0")).toBe(true);
    expect(d).toContain("C");
    // The final curve's endpoint is the last sample point.
    expect(d.trimEnd().endsWith("40 60")).toBe(true);
  });

  it("handles trivial inputs without throwing", () => {
    expect(smoothPath([])).toBe("");
    expect(smoothPath([vec(3, 4)])).toBe("M 3 4");
  });
});
