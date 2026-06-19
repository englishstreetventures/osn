import { describe, it, expect } from "vitest";

import { CROP_ASPECT, cropBackgroundStyle, isRenderableCrop } from "./image-crop";

describe("CROP_ASPECT", () => {
  it("locks each slot to a fixed display ratio (so the fraction render is WYSIWYG)", () => {
    expect(CROP_ASPECT.hero).toBeCloseTo(16 / 9);
    expect(CROP_ASPECT.story).toBeCloseTo(4 / 3);
    expect(CROP_ASPECT.event).toBeCloseTo(4 / 3);
  });
});

describe("organiser image-crop (mirror of cire/web)", () => {
  it("is not renderable for null or a full-frame identity crop", () => {
    expect(isRenderableCrop(null)).toBe(false);
    expect(isRenderableCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("renders a sub-rectangle with the same fraction maths as the guest site", () => {
    const style = cropBackgroundStyle("https://x/img.jpg", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(style).not.toBeNull();
    expect(style!["background-size"]).toBe("200.0000% 200.0000%");
    expect(style!["background-position"]).toBe("50.0000% 50.0000%");
  });

  it("returns null for an out-of-range rectangle (caller keeps object-cover)", () => {
    expect(cropBackgroundStyle("u", { x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });
});
