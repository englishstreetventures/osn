/**
 * Organiser mirror of the guest site's `cire/web/src/components/image-crop.ts`.
 * Same normalised crop rectangle (`{x,y,w,h}` source fractions, 0..1, plus the
 * optional captured source dims `natW`/`natH`) + the same UNIFORM background-image
 * render, so the thumbnail the organiser sees after cropping matches the guest
 * invite exactly. The organiser must never import cire/web internals, so this is a
 * small hand-kept copy — keep the two in lockstep.
 *
 * THE DISTORTION FIX (mirrors cire/web). The render uses a SINGLE-value
 * `background-size` so the image scales UNIFORMLY (never the old two-value
 * `Wx% Wy%` that stretched the image whenever the crop and box aspects differed).
 * The box adopts the crop's true pixel aspect via `cropAspectRatio`, so the
 * uniformly-scaled region fills it with no distortion and no letterboxing.
 *
 * The editor no longer LOCKS each slot to a single ratio — the organiser picks
 * from a few aspect presets (`ASPECT_PRESETS`), and the captured source dims make
 * the guest render exact for whatever shape they choose.
 */

export interface ImageCrop {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Source image natural width in px (optional; absent on legacy crops). */
  natW?: number;
  /** Source image natural height in px (optional; absent on legacy crops). */
  natH?: number;
}

/**
 * Each customisable slot's DEFAULT crop aspect (width ÷ height) — the box the
 * editor opens on, re-framed as a sensible starting preset rather than a hard
 * lock:
 *   - `hero`  — full-viewport backdrop; a wide 16∶9 frame.
 *   - `story` — the two-column story photo; a gentle 3∶2.
 *   - `event` — the event card photo; 4∶3.
 * The guest render is exact for any chosen shape (it reads the captured dims).
 */
export const CROP_ASPECT = {
  hero: 16 / 9,
  story: 3 / 2,
  event: 4 / 3,
} as const;

export type CropSlot = keyof typeof CROP_ASPECT;

/**
 * The aspect-ratio presets offered in the crop editor. `Original` keeps the
 * slot's default shape; `Freeform` unlocks the crop box (`aspectRatio: NaN` in
 * Cropper.js). The rest are fixed ratios. `Original`/`Freeform` resolve their
 * concrete value per-slot at use time (`presetAspectRatio`).
 */
export type AspectPresetId = "original" | "16:9" | "3:2" | "4:3" | "1:1" | "4:5" | "freeform";

export interface AspectPreset {
  id: AspectPresetId;
  label: string;
  /** Fixed ratio (w÷h), or null for Original (slot default) / Freeform (unlocked). */
  ratio: number | null;
}

export const ASPECT_PRESETS: readonly AspectPreset[] = [
  { id: "original", label: "Original", ratio: null },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "3:2", label: "3:2", ratio: 3 / 2 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:5", label: "4:5", ratio: 4 / 5 },
  { id: "freeform", label: "Free", ratio: null },
];

/**
 * Resolve a preset to the concrete `aspectRatio` Cropper.js should lock to for a
 * slot. `Original` → the slot default; `Freeform` → `NaN` (unlocked); a fixed
 * preset → its ratio.
 */
export function presetAspectRatio(preset: AspectPresetId, slot: CropSlot): number {
  if (preset === "freeform") return Number.NaN;
  if (preset === "original") return CROP_ASPECT[slot];
  const found = ASPECT_PRESETS.find((p) => p.id === preset);
  return found?.ratio ?? CROP_ASPECT[slot];
}

/**
 * Best-effort guess of which preset a saved crop was made with, so re-opening the
 * editor restores the chosen aspect. Compares the crop's true pixel aspect (from
 * its captured dims) against each fixed preset; falls back to Freeform when none
 * matches (a custom shape) or Original when the dims are absent (legacy crop).
 */
export function presetForCrop(crop: ImageCrop | null | undefined, slot: CropSlot): AspectPresetId {
  if (!crop) return "original";
  const aspect = cropAspectRatio(crop, Number.NaN);
  if (!Number.isFinite(aspect)) return "original"; // legacy crop, no dims
  if (Math.abs(aspect - CROP_ASPECT[slot]) < 0.02) return "original";
  for (const p of ASPECT_PRESETS) {
    if (p.ratio != null && Math.abs(aspect - p.ratio) < 0.02) return p.id;
  }
  return "freeform";
}

function inUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
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

/**
 * The crop's true pixel aspect (width ÷ height) when its source dims were
 * captured, else `fallback`. Mirrors `cropAspectRatio` in cire/web.
 */
export function cropAspectRatio(crop: ImageCrop | null | undefined, fallback: number): number {
  if (!crop) return fallback;
  const { w, h, natW, natH } = crop;
  if (!isPositiveFinite(natW) || !isPositiveFinite(natH)) return fallback;
  if (!isPositiveFinite(w) || !isPositiveFinite(h)) return fallback;
  const aspect = (w * natW) / (h * natH);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : fallback;
}

/**
 * UNIFORM crop render (single-value `background-size`) — the image keeps its
 * proportions, never stretched. The caller owns the box's `aspect-ratio` (use
 * `cropAspectRatio`) and `overflow: hidden`. Mirrors cire/web.
 */
export function cropBackgroundStyle(
  imageUrl: string,
  crop: ImageCrop | null | undefined,
): Record<string, string> | null {
  if (!isRenderableCrop(crop)) return null;
  const { x, y, w, h } = crop;
  const size = (100 / w).toFixed(4);
  const posX = w >= 1 ? "0" : ((x / (1 - w)) * 100).toFixed(4);
  const posY = h >= 1 ? "0" : ((y / (1 - h)) * 100).toFixed(4);
  return {
    "background-image": `url("${imageUrl}")`,
    "background-repeat": "no-repeat",
    "background-size": `${size}%`,
    "background-position": `${posX}% ${posY}%`,
  };
}
