import { describe, it, expect } from "bun:test";

import { Effect, Schema } from "effect";

import { cropAspect, decodeCrop, ImageCropBody, isValidCrop } from "./invite";

// Decode a crop body the way the route does; returns the parsed body or throws
// the ParseError so a test can assert acceptance/rejection.
function decodeBody(raw: unknown) {
  return Effect.runSync(
    Schema.decodeUnknown(ImageCropBody)(raw).pipe(
      Effect.catchTag("ParseError", () => Effect.fail("reject" as const)),
      Effect.either,
    ),
  );
}

describe("isValidCrop", () => {
  it("accepts a full-frame and an interior sub-rectangle", () => {
    expect(isValidCrop({ x: 0, y: 0, w: 1, h: 1 })).toBe(true);
    expect(isValidCrop({ x: 0.25, y: 0.1, w: 0.5, h: 0.5 })).toBe(true);
  });

  it("rejects a negative origin", () => {
    expect(isValidCrop({ x: -0.01, y: 0, w: 0.5, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: 0, y: -0.5, w: 0.5, h: 0.5 })).toBe(false);
  });

  it("rejects a zero or negative size", () => {
    expect(isValidCrop({ x: 0, y: 0, w: 0, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 0.5, h: -0.2 })).toBe(false);
  });

  it("rejects a box that runs off the right/bottom edge", () => {
    expect(isValidCrop({ x: 0.8, y: 0, w: 0.5, h: 0.5 })).toBe(false); // x+w = 1.3
    expect(isValidCrop({ x: 0, y: 0.9, w: 0.5, h: 0.5 })).toBe(false); // y+h = 1.4
  });

  it("rejects components above 1", () => {
    expect(isValidCrop({ x: 0, y: 0, w: 1.5, h: 0.5 })).toBe(false);
  });

  it("rejects non-finite / non-number components", () => {
    expect(isValidCrop({ x: Number.NaN, y: 0, w: 0.5, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: Number.POSITIVE_INFINITY, y: 0, w: 0.5, h: 0.5 })).toBe(false);
    expect(isValidCrop({ x: "0", y: 0, w: 0.5, h: 0.5 })).toBe(false);
    expect(isValidCrop(null)).toBe(false);
    expect(isValidCrop({})).toBe(false);
  });

  it("tolerates a hair-over-1 sum from float rounding (epsilon)", () => {
    expect(isValidCrop({ x: 0.5, y: 0, w: 0.5000001, h: 1 })).toBe(true);
  });
});

describe("ImageCropBody decode", () => {
  it("accepts a valid rectangle", () => {
    const r = decodeBody({ crop: { x: 0.1, y: 0.2, w: 0.4, h: 0.3 } });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") expect(r.right.crop).toEqual({ x: 0.1, y: 0.2, w: 0.4, h: 0.3 });
  });

  it("accepts crop: null (reset to full image)", () => {
    const r = decodeBody({ crop: null });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") expect(r.right.crop).toBeNull();
  });

  it("rejects an out-of-range rectangle with a ParseError", () => {
    expect(decodeBody({ crop: { x: 0.8, y: 0, w: 0.5, h: 0.5 } })._tag).toBe("Left");
    expect(decodeBody({ crop: { x: -1, y: 0, w: 0.5, h: 0.5 } })._tag).toBe("Left");
    expect(decodeBody({ crop: { x: 0, y: 0, w: 0, h: 0 } })._tag).toBe("Left");
  });

  it("rejects a malformed body (missing fields / wrong types)", () => {
    expect(decodeBody({ crop: { x: 0, y: 0, w: 0.5 } })._tag).toBe("Left");
    expect(decodeBody({ crop: "nope" })._tag).toBe("Left");
    expect(decodeBody(null)._tag).toBe("Left");
  });
});

describe("decodeCrop (read path defence-in-depth)", () => {
  it("returns the rectangle for valid stored JSON", () => {
    expect(decodeCrop(JSON.stringify({ x: 0.1, y: 0.1, w: 0.5, h: 0.5 }))).toEqual({
      x: 0.1,
      y: 0.1,
      w: 0.5,
      h: 0.5,
    });
  });

  it("returns null for null, malformed JSON, or an out-of-range rectangle", () => {
    expect(decodeCrop(null)).toBeNull();
    expect(decodeCrop("not json")).toBeNull();
    expect(decodeCrop(JSON.stringify({ x: 0.8, y: 0, w: 0.5, h: 0.5 }))).toBeNull();
    expect(decodeCrop(JSON.stringify({ nope: 1 }))).toBeNull();
  });
});

describe("source dimensions (natW / natH) — the distortion fix, no migration", () => {
  it("accepts a crop carrying positive-finite source dims", () => {
    expect(isValidCrop({ x: 0.1, y: 0.2, w: 0.4, h: 0.3, natW: 4000, natH: 3000 })).toBe(true);
  });

  it("tolerates a legacy crop with NO dims (back-compat)", () => {
    // The dims are optional — a value stored before this field existed is still
    // valid, so legacy rows decode unchanged (no DB migration needed).
    expect(isValidCrop({ x: 0.1, y: 0.2, w: 0.4, h: 0.3 })).toBe(true);
  });

  it("rejects a present-but-bad dimension (0 / negative / NaN / ∞ / non-number)", () => {
    expect(isValidCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 0, natH: 100 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: -1, natH: 100 })).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: Number.NaN, natH: 100 })).toBe(false);
    expect(
      isValidCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: Number.POSITIVE_INFINITY, natH: 100 }),
    ).toBe(false);
    expect(isValidCrop({ x: 0, y: 0, w: 0.5, h: 0.5, natW: "4000", natH: 3000 })).toBe(false);
  });

  it("round-trips the dims through the request body decode", () => {
    const r = decodeBody({ crop: { x: 0.1, y: 0.2, w: 0.4, h: 0.3, natW: 4000, natH: 3000 } });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.crop).toEqual({ x: 0.1, y: 0.2, w: 0.4, h: 0.3, natW: 4000, natH: 3000 });
    }
  });

  it("rejects a body whose dims are present but invalid", () => {
    expect(decodeBody({ crop: { x: 0, y: 0, w: 0.5, h: 0.5, natW: 0, natH: 100 } })._tag).toBe(
      "Left",
    );
  });

  it("round-trips the dims through decodeCrop on the read path", () => {
    expect(
      decodeCrop(JSON.stringify({ x: 0.1, y: 0.1, w: 0.5, h: 0.4, natW: 1200, natH: 800 })),
    ).toEqual({ x: 0.1, y: 0.1, w: 0.5, h: 0.4, natW: 1200, natH: 800 });
  });
});

describe("cropAspect (true pixel aspect of the cropped region)", () => {
  it("computes (w·natW)/(h·natH) when dims are present", () => {
    // 0.5×0.5 fraction of a 4000×2000 image → a 2000×1000 px region → 2:1.
    expect(cropAspect({ x: 0, y: 0, w: 0.5, h: 0.5, natW: 4000, natH: 2000 })).toBeCloseTo(2);
  });

  it("returns null for a legacy crop without dims (caller uses the slot default)", () => {
    expect(cropAspect({ x: 0, y: 0, w: 0.5, h: 0.5 })).toBeNull();
  });
});
