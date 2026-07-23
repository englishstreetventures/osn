import { describe, it, expect } from "vitest";

import {
  ASPECT_PRESETS,
  boxWithinBounds,
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
  fitAspectBox,
  isRenderableCrop,
  presetAspectRatio,
  presetForCrop,
} from "./image-crop";

describe("CROP_ASPECT", () => {
  it("opens each slot on a sensible default shape", () => {
    expect(CROP_ASPECT.hero).toBeCloseTo(16 / 9);
    expect(CROP_ASPECT.story).toBeCloseTo(3 / 2);
    expect(CROP_ASPECT.event).toBeCloseTo(4 / 3);
  });
});

describe("fitAspectBox", () => {
  // A letterboxed displayed image inside the editor canvas (like the harness
  // case that exposed the overflow bug: 800×500 image shown at 704×440@98,0).
  const bounds = { x: 98, y: 0, w: 704, h: 440 };

  it("fits the largest ratio-locked box fully inside the bounds", () => {
    const box = fitAspectBox(bounds, 16 / 9);
    // Width-limited: 704 wide ⇒ 396 tall, centred vertically inside 440.
    expect(box.w).toBeCloseTo(704);
    expect(box.h).toBeCloseTo(704 / (16 / 9));
    expect(box.x).toBeCloseTo(98);
    expect(box.y).toBeCloseTo((440 - box.h) / 2);
  });

  it("switches to height-limited when the ratio is narrower than the bounds", () => {
    const box = fitAspectBox(bounds, 1); // square inside a wide image
    expect(box.h).toBeCloseTo(440);
    expect(box.w).toBeCloseTo(440);
    expect(box.x).toBeGreaterThanOrEqual(bounds.x);
    expect(box.x + box.w).toBeLessThanOrEqual(bounds.x + bounds.w + 1e-6);
  });

  it("returns the whole bounds for a non-finite or non-positive (freeform) ratio", () => {
    expect(fitAspectBox(bounds, Number.NaN)).toEqual(bounds);
    expect(fitAspectBox(bounds, Number.POSITIVE_INFINITY)).toEqual(bounds);
    // A zero/negative ratio must not produce a degenerate (Infinity-height /
    // negative-size) box — the guard treats it as freeform.
    expect(fitAspectBox(bounds, 0)).toEqual(bounds);
    expect(fitAspectBox(bounds, -1)).toEqual(bounds);
  });

  it("clamps a requested centre so the box never escapes the bounds", () => {
    // Centre far in the top-left corner: box must clamp to the bounds' origin.
    const box = fitAspectBox(bounds, 1, bounds.x, bounds.y);
    expect(box.x).toBeCloseTo(bounds.x);
    expect(box.y).toBeCloseTo(bounds.y);
    // And far bottom-right clamps to the opposite edge.
    const box2 = fitAspectBox(bounds, 1, bounds.x + bounds.w, bounds.y + bounds.h);
    expect(box2.x + box2.w).toBeCloseTo(bounds.x + bounds.w);
    expect(box2.y + box2.h).toBeCloseTo(bounds.y + bounds.h);
  });
});

describe("boxWithinBounds", () => {
  // The crop editor's containment veto: selection changes outside the displayed
  // image get preventDefault()ed, with EDGE_EPS px of rounding slack.
  const bounds = { x: 98, y: 0, w: 704, h: 440 };
  const EPS = 1;

  it("accepts a box fully inside the bounds", () => {
    expect(boxWithinBounds({ x: 200, y: 100, w: 300, h: 200 }, bounds, EPS)).toBe(true);
  });

  it("accepts an image-hugging box within the rounding slack", () => {
    // Half a pixel outside every edge — whole-px rounding, not a real escape.
    expect(boxWithinBounds({ x: 97.5, y: -0.5, w: 705, h: 441 }, bounds, EPS)).toBe(true);
  });

  it("rejects a box escaping past the slack on any single edge", () => {
    const inside = { x: 200, y: 100, w: 300, h: 200 };
    expect(boxWithinBounds({ ...inside, x: bounds.x - 2 }, bounds, EPS)).toBe(false); // left
    expect(boxWithinBounds({ ...inside, y: bounds.y - 2 }, bounds, EPS)).toBe(false); // top
    expect(boxWithinBounds({ ...inside, w: bounds.w }, bounds, EPS)).toBe(false); // right
    expect(boxWithinBounds({ ...inside, h: bounds.h }, bounds, EPS)).toBe(false); // bottom
  });
});

describe("organiser image-crop (mirror of cire/web)", () => {
  it("is not renderable for null or a full-frame identity crop", () => {
    expect(isRenderableCrop(null)).toBe(false);
    expect(isRenderableCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("renders a sub-rectangle with a SINGLE-value (uniform) background-size", () => {
    const style = cropBackgroundStyle("https://x/img.jpg", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(style).not.toBeNull();
    // ONE value — the anti-distortion fix (was "200% 200%", which stretched).
    expect(style!["background-size"]).toBe("200.0000%");
    expect(style!["background-size"].trim().split(/\s+/)).toHaveLength(1);
    expect(style!["background-position"]).toBe("50.0000% 50.0000%");
  });

  it("returns null for an out-of-range rectangle (caller keeps object-cover)", () => {
    expect(cropBackgroundStyle("u", { x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });
});

describe("cropAspectRatio (mirror of cire/web)", () => {
  it("falls back without dims, computes (w·natW)/(h·natH) with them", () => {
    expect(cropAspectRatio({ x: 0, y: 0, w: 0.5, h: 0.5 }, 4 / 3)).toBe(4 / 3);
    expect(cropAspectRatio({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 4000, natH: 2000 }, 1)).toBeCloseTo(
      2,
    );
  });
});

describe("aspect presets", () => {
  it("offers the expected set of shapes (incl. Original + Free)", () => {
    expect(ASPECT_PRESETS.map((p) => p.id)).toEqual([
      "original",
      "16:9",
      "3:2",
      "4:3",
      "1:1",
      "4:5",
      "9:16",
      "freeform",
    ]);
  });

  it("resolves Original to the slot default and Freeform to NaN (unlocked)", () => {
    expect(presetAspectRatio("original", "hero")).toBeCloseTo(16 / 9);
    // The hero's phone rectangle opens on a tall 9:16 frame (0046).
    expect(presetAspectRatio("original", "hero-mobile")).toBeCloseTo(9 / 16);
    expect(presetAspectRatio("original", "event")).toBeCloseTo(4 / 3);
    expect(Number.isNaN(presetAspectRatio("freeform", "story"))).toBe(true);
    expect(presetAspectRatio("1:1", "event")).toBe(1);
    expect(presetAspectRatio("4:5", "event")).toBeCloseTo(4 / 5);
    expect(presetAspectRatio("9:16", "story")).toBeCloseTo(9 / 16);
  });

  it("re-opens the phone crop editor on the intended preset (hero-mobile tie-break)", () => {
    // A saved 9:16 rectangle IS the hero-mobile slot's default shape — the
    // editor must re-open on "original" (checked before the fixed presets), not
    // the explicit "9:16" preset that now resolves to the same ratio.
    expect(
      presetForCrop({ x: 0, y: 0, w: 0.28125, h: 0.5, natW: 1000, natH: 1000 }, "hero-mobile"),
    ).toBe("original");
    // A non-default shape on the phone slot resolves to its ratio preset.
    expect(
      presetForCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 1000, natH: 1000 }, "hero-mobile"),
    ).toBe("1:1");
  });

  it("restores a saved crop's preset from its captured dims (re-open the editor)", () => {
    // A square pixel crop → 1:1 preset.
    expect(presetForCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 1000, natH: 1000 }, "event")).toBe(
      "1:1",
    );
    // A crop matching the slot default → Original.
    expect(presetForCrop({ x: 0, y: 0, w: 0.5, h: 0.375, natW: 1000, natH: 1000 }, "event")).toBe(
      "original", // (0.5·1000)/(0.375·1000) = 1.333… = 4:3 = event default
    );
    // A legacy crop (no dims) → Original.
    expect(presetForCrop({ x: 0, y: 0, w: 0.5, h: 0.5 }, "event")).toBe("original");
    // No crop → Original.
    expect(presetForCrop(null, "hero")).toBe("original");
  });
});
