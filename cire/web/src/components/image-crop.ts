/**
 * Shared CSS render of a normalised crop rectangle, the guest-side twin of the
 * organiser's Cropper.js editor. The organiser drags/resizes/zooms a crop box and
 * we store the result as a normalised rectangle `{x,y,w,h}` in SOURCE FRACTIONS
 * (0..1): `x`/`y` the top-left of the visible region, `w`/`h` its size, each a
 * fraction of the original image's width/height. NULL ⇒ no crop ⇒ the default
 * centre `object-cover`, so an un-cropped image renders exactly as before.
 *
 * We render the crop in CSS (no Cloudflare Images region-crop, zero extra CF cost)
 * with the classic background-image fraction technique: the image is the
 * `background-image` of a fixed box, scaled so the crop region fills the box and
 * positioned so the region's top-left aligns. This is WYSIWYG-identical to what
 * Cropper.js showed the organiser AS LONG AS the crop box's aspect ratio matches
 * the display box's — which is why the editor LOCKS each slot's crop aspect ratio
 * to its guest display ratio (see `CROP_ASPECT` in the organiser). The formula is
 * independent of the source pixel dimensions, so we never need to capture or store
 * them.
 *
 *   background-size:     (1/w · 100)%  (1/h · 100)%
 *   background-position:  x/(1−w)·100%   y/(1−h)·100%   (0% when the axis is full)
 *
 * Keep this in lockstep with the organiser's `image-crop.ts` mirror.
 */

import type { ImageCrop } from "./types";

export type { ImageCrop };

/** A finite number in [0,1]; anything else (NaN/∞/out-of-range) is treated as absent. */
function inUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/**
 * A crop is renderable only when it is a well-formed in-bounds rectangle with a
 * strictly-positive, non-full size — a `{0,0,1,1}` (or absent) crop is the
 * identity, so we render the plain `object-cover` image instead (no transform).
 */
export function isRenderableCrop(crop: ImageCrop | null | undefined): crop is ImageCrop {
  if (!crop) return false;
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every((n) => inUnit(n))) return false;
  if (w <= 0 || h <= 0) return false;
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  // A full-frame crop is the identity — nothing to transform.
  if (w >= 0.9999 && h >= 0.9999) return false;
  return true;
}

/**
 * CSS `style` properties that render the cropped region of `imageUrl` inside a
 * fixed-ratio box, via the background-image fraction technique above. Returns the
 * background layer props only — the caller owns the box's size/aspect-ratio and
 * `overflow: hidden`. Returns `null` when the crop is absent/identity, so the
 * caller falls back to a plain `<img object-cover>`.
 */
export function cropBackgroundStyle(
  imageUrl: string,
  crop: ImageCrop | null | undefined,
): Record<string, string> | null {
  if (!isRenderableCrop(crop)) return null;
  const { x, y, w, h } = crop;
  const sizeX = (100 / w).toFixed(4);
  const sizeY = (100 / h).toFixed(4);
  // When an axis is full (w or h = 1) the denominator is 0 — position is then
  // irrelevant (the axis can't pan), so pin it to 0%.
  const posX = w >= 1 ? "0" : ((x / (1 - w)) * 100).toFixed(4);
  const posY = h >= 1 ? "0" : ((y / (1 - h)) * 100).toFixed(4);
  return {
    "background-image": `url("${imageUrl}")`,
    "background-repeat": "no-repeat",
    "background-size": `${sizeX}% ${sizeY}%`,
    "background-position": `${posX}% ${posY}%`,
  };
}
