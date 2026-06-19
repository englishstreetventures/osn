import { describe, it, expect } from "vitest";

import {
  ASPECT_PRESETS,
  CROP_ASPECT,
  cropAspectRatio,
  cropBackgroundStyle,
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
      "freeform",
    ]);
  });

  it("resolves Original to the slot default and Freeform to NaN (unlocked)", () => {
    expect(presetAspectRatio("original", "hero")).toBeCloseTo(16 / 9);
    expect(presetAspectRatio("original", "event")).toBeCloseTo(4 / 3);
    expect(Number.isNaN(presetAspectRatio("freeform", "story"))).toBe(true);
    expect(presetAspectRatio("1:1", "event")).toBe(1);
    expect(presetAspectRatio("4:5", "event")).toBeCloseTo(4 / 5);
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
