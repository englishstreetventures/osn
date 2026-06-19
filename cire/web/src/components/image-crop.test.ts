import { describe, it, expect } from "vitest";

import { cropBackgroundStyle, isRenderableCrop } from "./image-crop";

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

  it("maps a centred half-frame crop to size 200% and position 50%/50%", () => {
    // A 0.5×0.5 box centred at (0.25,0.25): size = 1/0.5 = 200%; position =
    // 0.25/(1-0.5) = 50% on each axis.
    const style = cropBackgroundStyle("https://x/img.jpg", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(style).not.toBeNull();
    expect(style!["background-image"]).toBe('url("https://x/img.jpg")');
    expect(style!["background-size"]).toBe("200.0000% 200.0000%");
    expect(style!["background-position"]).toBe("50.0000% 50.0000%");
    expect(style!["background-repeat"]).toBe("no-repeat");
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
