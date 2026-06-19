import { describe, it, expect } from "vitest";

import {
  cropAspectRatio,
  cropBackgroundStyle,
  heroCropBackgroundStyle,
  isRenderableCrop,
} from "./image-crop";

describe("isRenderableCrop", () => {
  it("treats null/undefined as not renderable (fall back to object-cover)", () => {
    expect(isRenderableCrop(null)).toBe(false);
    expect(isRenderableCrop(undefined)).toBe(false);
  });

  it("treats a full-frame crop as the identity (not renderable)", () => {
    expect(isRenderableCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(false);
  });

  it("accepts a genuine sub-rectangle", () => {
    expect(isRenderableCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 })).toBe(true);
  });

  it("rejects an out-of-range or degenerate rectangle", () => {
    expect(isRenderableCrop({ x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBe(false); // off-edge
    expect(isRenderableCrop({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false); // zero width
    expect(isRenderableCrop({ x: 0, y: 0, w: Number.NaN, h: 0.5 })).toBe(false);
  });
});

describe("cropBackgroundStyle", () => {
  it("returns null when there's no renderable crop (caller keeps plain object-cover)", () => {
    expect(cropBackgroundStyle("u", null)).toBeNull();
    expect(cropBackgroundStyle("u", { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it("maps a centred half-frame crop to a SINGLE-value size 200% and position 50%/50%", () => {
    // A 0.5×0.5 box centred at (0.25,0.25): size = 1/0.5 = 200%; position =
    // 0.25/(1-0.5) = 50% on each axis.
    const style = cropBackgroundStyle("https://x/img.jpg", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(style).not.toBeNull();
    expect(style!["background-image"]).toBe('url("https://x/img.jpg")');
    expect(style!["background-size"]).toBe("200.0000%");
    expect(style!["background-position"]).toBe("50.0000% 50.0000%");
    expect(style!["background-repeat"]).toBe("no-repeat");
  });

  it("uses a SINGLE-value background-size so the image scales UNIFORMLY (anti-distortion)", () => {
    // THE BUG: the old two-value `background-size: Wx% Wy%` scaled width and height
    // INDEPENDENTLY, stretching the image whenever the crop's aspect differed from
    // the box's. The render must now emit ONE value (height auto), which the
    // browser scales uniformly — even for a markedly non-square crop.
    const tall = cropBackgroundStyle("u", { x: 0.1, y: 0.05, w: 0.3, h: 0.8 });
    expect(tall).not.toBeNull();
    const size = tall!["background-size"];
    // Exactly one token (no space → no independent Y value).
    expect(size.trim().split(/\s+/)).toHaveLength(1);
    expect(size).toBe("333.3333%"); // 100 / 0.3, applied uniformly to both axes

    const wide = cropBackgroundStyle("u", { x: 0, y: 0.2, w: 0.9, h: 0.25 });
    expect(wide!["background-size"].trim().split(/\s+/)).toHaveLength(1);
  });

  it("pins the position to 0% on an axis that is full width/height", () => {
    // h = 1 (full height) — the y axis can't pan, so position-y is 0%.
    const style = cropBackgroundStyle("u", { x: 0.5, y: 0, w: 0.5, h: 1 });
    expect(style).not.toBeNull();
    const [posX, posY] = style!["background-position"].split(" ");
    expect(posX).toBe("100.0000%"); // x/(1-w) = 0.5/0.5 = 100%
    expect(posY).toBe("0%");
  });
});

describe("cropAspectRatio (box adopts the crop's true pixel aspect)", () => {
  it("returns the fallback when the source dims are absent (legacy crop)", () => {
    expect(cropAspectRatio({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 4 / 3)).toBe(4 / 3);
    expect(cropAspectRatio(null, 16 / 9)).toBe(16 / 9);
  });

  it("computes (w·natW)/(h·natH) when dims are present", () => {
    // A square crop fraction on a 4000×2000 image is a 2:1 pixel rectangle.
    expect(cropAspectRatio({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 4000, natH: 2000 }, 1)).toBeCloseTo(
      2,
    );
    // A 0.6×0.3 crop on a 1000×1000 image → (0.6·1000)/(0.3·1000) = 2.
    expect(cropAspectRatio({ x: 0, y: 0, w: 0.6, h: 0.3, natW: 1000, natH: 1000 }, 1)).toBeCloseTo(
      2,
    );
  });

  it("falls back on a bad/zero dimension rather than producing a non-finite aspect", () => {
    expect(cropAspectRatio({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 0, natH: 100 }, 4 / 3)).toBe(4 / 3);
    expect(
      cropAspectRatio({ x: 0, y: 0, w: 0.5, h: 0.5, natW: Number.NaN, natH: 100 }, 4 / 3),
    ).toBe(4 / 3);
  });
});

describe("anti-distortion invariant (uniform scale on both axes)", () => {
  // The render scales the image by a SINGLE factor (single-value background-size,
  // height auto), and the box adopts the crop's TRUE pixel aspect (cropAspectRatio).
  // The distortion-free guarantee: model the image painted into a box of arbitrary
  // pixel dimensions, then check the cropped region lands flush with the box on
  // BOTH axes using ONE uniform image scale — i.e. the same scale satisfies width
  // and height simultaneously. The OLD two-value `Wx% Wy%` could only do that by
  // using two DIFFERENT scales (the stretch); a single scale doing it on both axes
  // is exactly "no distortion".
  it("fills the box on both axes with a single uniform scale (no stretch)", () => {
    const crop = { x: 0.1, y: 0.2, w: 0.4, h: 0.25, natW: 3000, natH: 2000 };
    const style = cropBackgroundStyle("u", crop)!;

    // Give the box a concrete width; its height follows the crop's pixel aspect,
    // which is what the component sets via `cropAspectRatio`.
    const boxW = 1000;
    const boxAspect = cropAspectRatio(crop, 1); // (w·natW)/(h·natH)
    const boxH = boxW / boxAspect;

    // Single-value background-size ⇒ the image's DISPLAYED width is `size%` of the
    // box width, and its height scales by the SAME factor (height auto = uniform).
    const sizePct = Number.parseFloat(style["background-size"]); // one token, e.g. 250
    const imgDisplayW = (sizePct / 100) * boxW;
    const scale = imgDisplayW / crop.natW; // the single uniform image scale factor
    const imgDisplayH = scale * crop.natH; // height uses the SAME scale (not stretched)

    // The crop region is the `w`×`h` fraction of the (uniformly) scaled image.
    const regionW = crop.w * imgDisplayW;
    const regionH = crop.h * imgDisplayH;

    // It must land flush with the box on BOTH axes — proving one scale fits both,
    // i.e. no per-axis stretch was needed to make it fit.
    expect(regionW).toBeCloseTo(boxW, 6);
    expect(regionH).toBeCloseTo(boxH, 6);
  });
});

describe("heroCropBackgroundStyle (full-bleed focal cover)", () => {
  it("returns null for an absent/identity crop", () => {
    expect(heroCropBackgroundStyle("u", null)).toBeNull();
    expect(heroCropBackgroundStyle("u", { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });

  it("covers uniformly and centres on the crop region's focal point", () => {
    // Crop centred at (0.25+0.25, 0.1+0.2) = (0.5, 0.3).
    const style = heroCropBackgroundStyle("https://x/h.jpg", {
      x: 0.25,
      y: 0.1,
      w: 0.5,
      h: 0.4,
    })!;
    expect(style["background-size"]).toBe("cover"); // uniform, no stretch, no letterbox
    expect(style["background-position"]).toBe("50.0000% 30.0000%");
  });
});
