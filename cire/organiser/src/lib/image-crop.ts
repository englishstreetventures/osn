/**
 * Organiser mirror of the guest site's `cire/web/src/components/image-crop.ts`.
 * Same normalised crop rectangle (`{x,y,w,h}` source fractions, 0..1) + the same
 * background-image fraction render, so the thumbnail the organiser sees after
 * cropping matches the guest invite exactly. The organiser must never import
 * cire/web internals, so this is a small hand-kept copy — keep the two in lockstep.
 *
 * Each customisable slot LOCKS its Cropper.js aspect ratio to the guest display
 * box's ratio (`CROP_ASPECT` below), which is what makes the fraction render
 * WYSIWYG without ever needing the source pixel dimensions.
 */

export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The aspect ratio (width ÷ height) each slot's crop box is locked to, matching
 * the guest display box:
 *   - `hero`  — full-viewport backdrop; a wide 16∶9 frame is a sensible default.
 *   - `story` — the two-column story photo (~4∶3 on desktop).
 *   - `event` — the event card photo (~4∶3).
 * Keep in sync with the guest render boxes in InviteHeader / EventCard.
 */
export const CROP_ASPECT = {
  hero: 16 / 9,
  story: 4 / 3,
  event: 4 / 3,
} as const;

export type CropSlot = keyof typeof CROP_ASPECT;

function inUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

export function isRenderableCrop(crop: ImageCrop | null | undefined): crop is ImageCrop {
  if (!crop) return false;
  const { x, y, w, h } = crop;
  if (![x, y, w, h].every((n) => inUnit(n))) return false;
  if (w <= 0 || h <= 0) return false;
  if (x + w > 1.0001 || y + h > 1.0001) return false;
  if (w >= 0.9999 && h >= 0.9999) return false;
  return true;
}

export function cropBackgroundStyle(
  imageUrl: string,
  crop: ImageCrop | null | undefined,
): Record<string, string> | null {
  if (!isRenderableCrop(crop)) return null;
  const { x, y, w, h } = crop;
  const sizeX = (100 / w).toFixed(4);
  const sizeY = (100 / h).toFixed(4);
  const posX = w >= 1 ? "0" : ((x / (1 - w)) * 100).toFixed(4);
  const posY = h >= 1 ? "0" : ((y / (1 - h)) * 100).toFixed(4);
  return {
    "background-image": `url("${imageUrl}")`,
    "background-repeat": "no-repeat",
    "background-size": `${sizeX}% ${sizeY}%`,
    "background-position": `${posX}% ${posY}%`,
  };
}
