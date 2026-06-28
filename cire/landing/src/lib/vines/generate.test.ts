import { describe, expect, it } from "vitest";

import { computeRoots, generateField } from "./generate";
import { makeRng } from "./prng";

describe("generateField", () => {
  it("is fully deterministic for a given seed (server/client parity)", () => {
    const a = generateField("amara-and-sam", 1280, 5200);
    const b = generateField("amara-and-sam", 1280, 5200);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("produces a different field for a different seed", () => {
    const a = generateField("seed-a", 1280, 5200);
    const b = generateField("seed-b", 1280, 5200);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("emits at least a few vines with stroked strands and organs", () => {
    const field = generateField("structure", 1280, 5200);
    expect(field.vines.length).toBeGreaterThanOrEqual(3);
    for (const vine of field.vines) {
      expect(vine.strands.length).toBeGreaterThanOrEqual(1);
      // Every strand is a smooth path with a normalized draw window a0 < a1.
      for (const strand of vine.strands) {
        expect(strand.d.startsWith("M ")).toBe(true);
        expect(strand.a1).toBeGreaterThan(strand.a0);
        expect(strand.a0).toBeGreaterThanOrEqual(0);
        expect(strand.a1).toBeLessThanOrEqual(1.001);
      }
      // Leaves carry filled, closed path data + a reveal point in [0,1].
      for (const leaf of vine.leaves) {
        expect(leaf.d.endsWith("Z")).toBe(true);
        expect(leaf.a).toBeGreaterThanOrEqual(0);
        expect(leaf.a).toBeLessThanOrEqual(1);
      }
    }
  });

  it("anchors roots to alternating edges within the canvas height", () => {
    const width = 1000;
    const height = 4000;
    const roots = computeRoots(width, height, makeRng("roots-test"));
    expect(roots.length).toBeGreaterThanOrEqual(3);
    for (const root of roots) {
      expect(root.y).toBeGreaterThanOrEqual(0);
      expect(root.y).toBeLessThanOrEqual(height);
      // Left-edge roots sit near x=0, right-edge near x=width.
      const anchoredToEdge = root.side < 0 ? root.x < width * 0.2 : root.x > width * 0.8;
      expect(anchoredToEdge).toBe(true);
    }
    // Both edges are planted (mostly alternating, with occasional repeats).
    expect(roots.some((root) => root.side < 0)).toBe(true);
    expect(roots.some((root) => root.side > 0)).toBe(true);
  });
});
