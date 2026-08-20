/**
 * Shared CSS render of a normalised crop rectangle, the guest-side twin of the
 * organiser's Cropper.js editor. The organiser drags/resizes/zooms a crop box and
 * we store the result as a normalised rectangle `{x,y,w,h}` in SOURCE FRACTIONS
 * (0..1): `x`/`y` the top-left of the visible region, `w`/`h` its size, each a
 * fraction of the original image's width/height. NULL ⇒ no crop ⇒ the default
 * centre `object-cover`, so an un-cropped image renders exactly as before.
 *
 * We render the crop in CSS (no Cloudflare Images region-crop, zero extra CF cost)
 * with the background-image fraction technique: the image is the `background-image`
 * of a box, scaled so the crop region fills the box and positioned so the region's
 * top-left aligns.
 *
 * THE DISTORTION FIX. The previous render used a TWO-value `background-size`
 * (`Wx% Wy%`), which scales width and height INDEPENDENTLY — so whenever the crop
 * rectangle's aspect ratio differed from the display box's, the image was
 * non-uniformly scaled and came out stretched/squashed. A cropped image must NEVER
 * stretch. We now use a SINGLE-value `background-size` (`W%`, height auto), which
 * scales the image UNIFORMLY (one factor on both axes, preserving its proportions),
 * and we make the box adopt the crop's TRUE PIXEL ASPECT (`cropAspectRatio`) so the
 * uniformly-scaled region fills the box exactly — no stretch, no letterboxing.
 *
 * The pixel aspect needs the source's natural dimensions, captured in the browser
 * at crop time and stored in the crop JSON as `natW`/`natH` (no DB migration — the
 * crop columns are plain JSON TEXT). A legacy `{x,y,w,h}` crop has no dims, so the
 * caller falls back to the slot's default display aspect — the previous behaviour,
 * minus the stretch (single-axis scale is uniform regardless).
 *
 *   background-size:     (1/w · 100)%            (single value ⇒ uniform scale)
 *   background-position:  x/(1−w)·100%   y/(1−h)·100%   (0% when the axis is full)
 *   box aspect-ratio:     (w·natW)/(h·natH)       (else the slot default)
 *
 * Keep this in lockstep with the organiser's `image-crop.ts` mirror.
 */

import type { ImageCrop } from "./types";

export type { ImageCrop };

/** A finite number in [0,1]; anything else (NaN/∞/out-of-range) is treated as absent. */
function inUnit(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
}

/** A finite, strictly-positive number (used to validate the optional source dims). */
function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
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
 * The range a crop's pixel aspect may land in. `natW`/`natH` are captured in the
 * browser and stored as plain JSON, and the API validates only that they are
 * positive and finite — so a wedding editor can persist `natW: 1e308,
 * natH: 1e-300`, whose ratio stringifies to `"1e+308"`. CSS rejects exponential
 * notation, the `aspect-ratio` declaration is dropped, and the band renders as a
 * zero-height box for every guest of that wedding. Clamping at the point the
 * value is produced covers the guest band and the organiser preview together
 * (S-L1); anything outside the range falls back to the slot default.
 */
const MIN_CROP_ASPECT = 0.05;
const MAX_CROP_ASPECT = 20;

/**
 * The crop's true pixel aspect ratio (width ÷ height) when the source dimensions
 * were captured at crop time, else `fallback` (the slot's default display aspect).
 * The displayed region's pixel shape is `(w·natW)/(h·natH)`; giving the box this
 * aspect means the uniformly-scaled image fills it with no distortion and no empty
 * bars. A legacy crop (no `natW`/`natH`) yields the fallback, preserving today's
 * fixed-ratio behaviour.
 */
export function cropAspectRatio(crop: ImageCrop | null | undefined, fallback: number): number {
  if (!crop) return fallback;
  const { w, h, natW, natH } = crop;
  if (!isPositiveFinite(natW) || !isPositiveFinite(natH)) return fallback;
  if (!isPositiveFinite(w) || !isPositiveFinite(h)) return fallback;
  const aspect = (w * natW) / (h * natH);
  if (!Number.isFinite(aspect) || aspect < MIN_CROP_ASPECT || aspect > MAX_CROP_ASPECT) {
    return fallback;
  }
  return aspect;
}

/**
 * CSS `style` properties that render the cropped region of `imageUrl` inside a box,
 * scaled UNIFORMLY (single-value `background-size`) so the image keeps its
 * proportions — never stretched. Returns the background layer props only; the
 * caller owns the box's `aspect-ratio` (use `cropAspectRatio`) and `overflow:
 * hidden`. Returns `null` when the crop is absent/identity, so the caller falls
 * back to a plain `<img object-cover>`.
 */
/**
 * Escape a URL for interpolation inside a CSS `url("…")` string context
 * (S-L1): backslash + double-quote are escaped and control characters
 * stripped, so the value can never terminate the string no matter where a
 * caller sourced it. Today every caller passes a server-built path, but the
 * helper's contract is "any string" — the sink defends itself.
 */
function cssUrlValue(imageUrl: string): string {
  let out = "";
  for (const ch of imageUrl) {
    if (ch.charCodeAt(0) < 0x20) continue; // strip control characters
    if (ch === "\\" || ch === '"') out += "\\";
    out += ch;
  }
  return out;
}

export function cropBackgroundStyle(
  imageUrl: string,
  crop: ImageCrop | null | undefined,
): Record<string, string> | null {
  if (!isRenderableCrop(crop)) return null;
  const { x, y, w, h } = crop;
  // SINGLE-value background-size: the image scales uniformly to `size%` of the box
  // width with height `auto` (the browser keeps the image's intrinsic ratio). With
  // the box at the crop's pixel aspect, `size = 100/w` makes the crop region fill
  // the box on both axes with ONE scale factor — the anti-distortion invariant.
  const size = (100 / w).toFixed(4);
  // When an axis is full (w or h = 1) the denominator is 0 — position is then
  // irrelevant (the axis can't pan), so pin it to 0%.
  const posX = w >= 1 ? "0" : ((x / (1 - w)) * 100).toFixed(4);
  const posY = h >= 1 ? "0" : ((y / (1 - h)) * 100).toFixed(4);
  return {
    "background-image": `url("${cssUrlValue(imageUrl)}")`,
    "background-repeat": "no-repeat",
    "background-size": `${size}%`,
    "background-position": `${posX}% ${posY}%`,
  };
}

/**
 * Hero variant of the crop render. The hero is a full-bleed backdrop whose box is
 * the hero SECTION (a fixed viewport shape, not the crop's aspect), so an
 * exact-fit render would letterbox. Instead we treat the crop as a FOCAL POINT:
 * the image covers the whole hero (`background-size: cover`, uniform scaling) and
 * is positioned so the crop region's centre sits at the hero's centre. That keeps
 * the organiser's framing intent (pan/zoom focal area) with cover semantics — no
 * distortion, no empty bars. Returns `null` for an absent/identity crop so the
 * caller keeps the plain cover `<img>`.
 */
export function heroCropBackgroundStyle(
  imageUrl: string,
  crop: ImageCrop | null | undefined,
): Record<string, string> | null {
  if (!isRenderableCrop(crop)) return null;
  const { x, y, w, h } = crop;
  // The crop region's centre in source fractions → a CSS focal `background-position`
  // (the classic object-position focal-point technique). Clamped to [0,1] so a
  // rounding hair can't push it out of range.
  const cx = clamp01(x + w / 2);
  const cy = clamp01(y + h / 2);
  return {
    "background-image": `url("${cssUrlValue(imageUrl)}")`,
    "background-repeat": "no-repeat",
    "background-size": "cover",
    "background-position": `${(cx * 100).toFixed(4)}% ${(cy * 100).toFixed(4)}%`,
  };
}

/** Clamp a fraction into [0,1]. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * The `image-set()` sibling of {@link cropBackgroundStyle}, for a background
 * layer that must vary by DEVICE-PIXEL-RATIO as well as crop. `image-set()`
 * selects on DPR only — it cannot see viewport width — so a caller pairs this
 * with a breakpoint (render it below the viewport cutoff, a plain
 * {@link cropBackgroundStyle} hero-variant layer above it) to cover both axes.
 *
 * A style OBJECT cannot carry `background-image` twice, so this returns a CSS
 * declaration STRING instead (Solid's `style` prop accepts a string, not just
 * an object): the plain `url()` FIRST — Safari < 17 has no unprefixed
 * `image-set`, and CSS drops a declaration it can't parse, so an unsupporting
 * browser keeps this one — then `image-set()` SECOND, which a supporting
 * browser parses and applies, overriding the first. `oneXUrl`/`twoXUrl` must
 * already carry a bounded `?variant=` (`VARIANT_WIDTHS` in
 * `invite-images.ts`) — this helper only renders the two URLs it's given, it
 * does not choose or validate variant names. Every other declaration matches
 * {@link cropBackgroundStyle}'s crop maths exactly, so the two stay
 * byte-identical for the same crop.
 */
export function cropBackgroundImageSetDeclaration(
  oneXUrl: string,
  twoXUrl: string,
  crop: ImageCrop | null | undefined,
): string | null {
  // Crop maths is never re-derived here — it is read back off the object
  // helper, so the two can't drift apart under a later edit to one of them.
  const base = cropBackgroundStyle(oneXUrl, crop);
  if (!base) return null;
  const oneX = cssUrlValue(oneXUrl);
  const twoX = cssUrlValue(twoXUrl);
  const rest = Object.entries(base)
    .filter(([property]) => property !== "background-image")
    .map(([property, value]) => `${property}:${value};`)
    .join("");
  return (
    `background-image:url("${oneX}");` +
    `background-image:image-set(url("${oneX}") 1x, url("${twoX}") 2x);` +
    rest
  );
}

/**
 * The hero's per-breakpoint crop layers (migration 0046). The hero is the one
 * full-bleed image rendered at both wide-desktop and tall-phone aspects, so the
 * organiser can save TWO focal rectangles: the desktop crop governs wide
 * viewports, the optional mobile crop governs narrow ones. Each layer is a
 * {@link heroCropBackgroundStyle} result (or `null` ⇒ that breakpoint keeps the
 * plain centre-cover `<img>`).
 *
 * The design packs render `wide` in a `hidden md:block` div and `narrow` in a
 * `md:hidden` div — `md` being the packs' existing mobile/desktop boundary.
 */
export interface HeroCropLayers {
  /** Layer for the desktop breakpoint (`md:` and up), or null ⇒ plain cover. */
  wide: Record<string, string> | null;
  /** Layer for narrow viewports (below `md:`), or null ⇒ plain cover. */
  narrow: Record<string, string> | null;
}

/**
 * Resolve both hero crop layers with the fallback chain: the mobile rectangle
 * wins below the breakpoint when set; otherwise narrow viewports fall back to
 * the DESKTOP rectangle — exactly the pre-0046 render, where the single crop
 * applied at every width. An absent/identity rectangle on both ⇒ both layers
 * null ⇒ the plain centre-cover `<img>` everywhere (also unchanged).
 */
export function heroCropLayers(
  imageUrl: string,
  desktopCrop: ImageCrop | null | undefined,
  mobileCrop: ImageCrop | null | undefined,
): HeroCropLayers {
  const wide = heroCropBackgroundStyle(imageUrl, desktopCrop);
  const narrow = heroCropBackgroundStyle(imageUrl, mobileCrop) ?? wide;
  return { wide, narrow };
}

/**
 * Opacity classes for the plain hero `<img>` once it has LOADED: visible only at
 * the breakpoints no crop layer covers, so the img and the crop divs never
 * paint over each other. (Before load the caller keeps it at `opacity-0`
 * regardless.) Breakpoint-conditional visibility has to be classes, not the old
 * inline `opacity` style — an inline value can't vary with the viewport.
 *
 * Three cases, returned as full literals so Tailwind's scanner sees them:
 *  - a wide layer exists ⇒ every breakpoint is covered (`narrow` falls back to
 *    it), img stays hidden everywhere;
 *  - only a narrow layer ⇒ img hidden on phones, visible from `md:` up;
 *  - no layers ⇒ img visible everywhere (the pre-crop behaviour).
 */
export function heroImgRevealClass(layers: HeroCropLayers): string {
  if (layers.wide) return "opacity-0";
  if (layers.narrow) return "opacity-0 md:opacity-100";
  return "opacity-100";
}
