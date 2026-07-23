import {
  FONT_CHOICES,
  isSafeCssColor,
  PALETTE_PRESET_KEYS,
  PALETTE_SEED_KEYS,
  SECTION_TONES,
} from "@cire/theme";
import { Schema } from "effect";

// ── Image slots ───────────────────────────────────────────────────────────────

/**
 * The fixed set of customisable image slots on the invite. Closed on purpose:
 * the builder is deliberately a few well-placed slots, not a generic
 * page-builder. This union is the single source of truth — it bounds the
 * `:slot` route param, the R2 key namespace, and (imported via `import type`)
 * the bounded span/log attributes. Adding a slot is a conscious schema change,
 * never a free-form string.
 */
export const INVITE_IMAGE_SLOTS = ["hero", "story"] as const;
export type InviteImageSlot = (typeof INVITE_IMAGE_SLOTS)[number];

export function isInviteImageSlot(value: string): value is InviteImageSlot {
  return (INVITE_IMAGE_SLOTS as readonly string[]).includes(value);
}

// ── Image crop rectangle ──────────────────────────────────────────────────────

/**
 * A normalised crop rectangle in SOURCE FRACTIONS (0..1): `x`/`y` are the
 * top-left of the visible region, `w`/`h` its size, each as a fraction of the
 * original image's width/height. ONE rectangle captures both pan and zoom — a
 * crop with zoom is just a smaller `{w,h}` box panned by `{x,y}`. `null` (a
 * NULL column) means "no crop" → the default centre `object-cover`, so an
 * un-cropped image renders exactly as before.
 *
 * `natW`/`natH` are the source image's NATURAL pixel dimensions, captured in the
 * browser at crop time. They are what makes the guest render distortion-proof:
 * the crop's true pixel aspect ratio is `(w·natW)/(h·natH)`, so the guest box can
 * adopt that aspect and the (UNIFORMLY-scaled) image fills it with no stretch and
 * no letterboxing. They are OPTIONAL — a legacy `{x,y,w,h}` value (saved before
 * this field existed) decodes fine and falls back to the slot's default display
 * aspect, exactly as before. So NO DB migration is needed: the crop columns stay
 * plain JSON TEXT (`hero_image_crop` / `story_image_crop` / `event_image_crop`);
 * we only widened the JSON shape and kept it legacy-tolerant.
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

/** A finite, strictly-positive number (used to validate the optional dims). */
function isPositiveFinite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

/**
 * The valid bounds for a crop rectangle. The box must lie fully inside the
 * source: every component in [0, 1], a strictly-positive size, and the box
 * not running off the right/bottom edge. This is the security gate — the
 * rectangle is interpolated into a guest-facing inline `style`, so an
 * out-of-range value must NEVER be persisted (reject the whole save).
 *
 * The optional `natW`/`natH` are validated ONLY when present (positive finite
 * numbers); their absence is fine — a legacy `{x,y,w,h}` crop is still valid.
 * They are NOT part of the security gate (only the bounded `x,y,w,h` reach an
 * inline style), but a non-positive/NaN dim is rejected so a downstream aspect
 * computation can never divide by zero or go non-finite.
 */
export function isValidCrop(value: unknown): value is ImageCrop {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  const { x, y, w, h, natW, natH } = c;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof w !== "number" ||
    typeof h !== "number"
  ) {
    return false;
  }
  if ([x, y, w, h].some((n) => !Number.isFinite(n))) return false;
  if (x < 0 || y < 0 || w <= 0 || h <= 0) return false;
  if (x > 1 || y > 1 || w > 1 || h > 1) return false;
  // Use a tiny epsilon so floating-point rounding from the cropper (e.g. a box
  // that fills the image, x+w = 1.0000001) isn't spuriously rejected.
  const EPS = 1e-6;
  if (x + w > 1 + EPS || y + h > 1 + EPS) return false;
  // Optional source dims: tolerate absence (legacy crop), reject a present-but-bad
  // value so the stored shape can't carry a 0/NaN/∞ dimension.
  if (natW !== undefined && !isPositiveFinite(natW)) return false;
  if (natH !== undefined && !isPositiveFinite(natH)) return false;
  return true;
}

/**
 * The crop's true pixel aspect ratio (width ÷ height) when the source dimensions
 * were captured, else `null`. With both dims known, the displayed region's pixel
 * shape is `(w·natW) / (h·natH)`; the guest box adopts this so a uniformly-scaled
 * image fills it exactly. `null` ⇒ the caller falls back to the slot's default
 * display aspect (the legacy behaviour).
 */
export function cropAspect(crop: ImageCrop): number | null {
  const { w, h, natW, natH } = crop;
  if (!isPositiveFinite(natW) || !isPositiveFinite(natH)) return null;
  const aspect = (w * natW) / (h * natH);
  return Number.isFinite(aspect) && aspect > 0 ? aspect : null;
}

/**
 * A nullable crop field. `null` clears the crop back to the default centre
 * `object-cover`; a present value must be a valid rectangle (see
 * {@link isValidCrop}) or the whole body is rejected with a 400 — never
 * persisted. The decode passes the validated rectangle through unchanged.
 *
 * `natW`/`natH` are optional (the browser supplies them on a fresh crop; an old
 * client or a legacy value omits them). They are validated by `isValidCrop` when
 * present; `Schema.optional` keeps the round-trip total either way.
 */
const CropField = Schema.NullOr(
  Schema.Struct({
    x: Schema.Number,
    y: Schema.Number,
    w: Schema.Number,
    h: Schema.Number,
    natW: Schema.optional(Schema.Number),
    natH: Schema.optional(Schema.Number),
  }).pipe(
    Schema.filter((c) => isValidCrop(c), {
      message: () => "Invalid crop rectangle (each value 0..1, w/h > 0, x+w ≤ 1, y+h ≤ 1)",
    }),
  ),
);

/**
 * Which viewport class a crop rectangle targets (migration 0046). The hero is
 * the one full-bleed image rendered at both wide-desktop and tall-phone
 * aspects, so it carries TWO rectangles: `desktop` (the default — also what
 * every pre-0046 client saves) governs wide viewports, `mobile` governs narrow
 * ones. Closed union on purpose: it is persisted into a bounded column choice,
 * never a free-form string.
 */
export const CROP_SCREENS = ["desktop", "mobile"] as const;
export type CropScreen = (typeof CROP_SCREENS)[number];

/**
 * Request body for saving a single image's crop rectangle (the wedding-slot
 * `hero`/`story` and the per-event image share this shape). `crop: null` resets
 * the image to the default centre crop. The rectangle is validated against the
 * bounds above before it reaches the service.
 *
 * `screen` is optional and defaults to `desktop` (the pre-0046 behaviour, so an
 * older client's body keeps meaning what it always did). `mobile` is only
 * meaningful for the `hero` slot — the route rejects it elsewhere; the story and
 * event images render at a single aspect and keep one rectangle.
 */
export const ImageCropBody = Schema.Struct({
  crop: CropField,
  screen: Schema.optional(Schema.Literal(...CROP_SCREENS)),
});
export type ImageCropBody = Schema.Schema.Type<typeof ImageCropBody>;

/**
 * Parse a JSON-encoded crop column into a validated rectangle, dropping anything
 * that isn't a well-formed in-bounds rectangle to `null`. Defence-in-depth: a
 * legacy/corrupt row never leaks a bad rectangle into the guest-facing style.
 */
export function decodeCrop(raw: string | null): ImageCrop | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return isValidCrop(parsed) ? parsed : null;
}

// ── Text customisation ────────────────────────────────────────────────────────

// A nullable, length-bounded copy field. `null` (or an all-whitespace value the
// service normalises to null) means "fall back to the built-in default". Caps
// keep a compromised/abusive organiser token from stuffing the public invite
// with unbounded text.
const copyField = (max: number) => Schema.NullOr(Schema.String.pipe(Schema.maxLength(max)));

/**
 * Full set of text overrides. The builder form always submits every field, so
 * the body is total (each key present) — a `null`/empty value clears the
 * override back to the default rather than leaving the previous value.
 */
export const InviteTextBody = Schema.Struct({
  heroTitle: copyField(120),
  heroSubtitle: copyField(200),
  storyEyebrow: copyField(80),
  storyHeading: copyField(160),
  storyBody: copyField(4000),
  // Events ("details") section header — the eyebrow + heading above the guest's
  // event cards (defaults "Celebrate With Us" / "Your Events"). Same caps as the
  // story eyebrow/heading — they render in the same visual slots.
  detailsEyebrow: copyField(80),
  detailsHeading: copyField(160),
  // Post-claim welcome greeting — the line under the family/guest name (default
  // "We are delighted to invite you to celebrate with us."). A short personal
  // sentence or two, so a modest cap.
  welcomeMessage: copyField(300),
  // Optional host override for the FIRST line of the copyable invite message
  // (the line above the guest-site URL + family code). A free-text string capped
  // at 600 chars — a couple of short sentences, enough for a warm personal note
  // without letting a compromised token stuff the clipboard payload unbounded.
  // Copied as plain text, never rendered as HTML, so no escaping; trimmed +
  // empty/whitespace-to-null by the service like the other copy fields.
  inviteMessage: copyField(600),
});
export type InviteTextBody = Schema.Schema.Type<typeof InviteTextBody>;

// ── Hero display sliders ────────────────────────────────────────────────────────

/**
 * Fine-grained hero display sliders (organiser choice; migration 0018 replaced
 * the coarse 0017 `blurred|regular` / `none|solid` enums). Each is a bounded
 * integer with a default that reproduces TODAY's look:
 *
 *  - `heroBlur` (0–40, default 28) — the server-side Gaussian blur radius on the
 *    hero backdrop image. 28 = the current soft `hero-bg` look; 0 = the sharp
 *    full-bleed photo. This is now PER-WEDDING (it overrides the former fixed
 *    `VARIANT_BLUR["hero-bg"]` constant), so the serve route reads it off the row
 *    and saving it bumps `updatedAt` to bust the transform cache.
 *  - `titleBackdropOpacity` (0–100, default 0) — opacity (÷100) of the dark
 *    legibility panel behind the hero title text. 0 = no panel.
 *  - `titleBackdropBlur` (0–20, default 0) — frosted-glass `backdrop-filter` blur
 *    in px behind the title. 0 = no frost.
 *
 * Bounds are enforced server-side: an out-of-range value is CLAMPED into the
 * range (not rejected) so a slightly-stale client can't 400 the whole theme
 * save, while a non-integer / non-number is a ParseError → 400.
 */
export const HERO_BLUR_MIN = 0;
export const HERO_BLUR_MAX = 40;
export const HERO_BLUR_DEFAULT = 28;
export const TITLE_BACKDROP_OPACITY_MIN = 0;
export const TITLE_BACKDROP_OPACITY_MAX = 100;
export const TITLE_BACKDROP_BLUR_MIN = 0;
export const TITLE_BACKDROP_BLUR_MAX = 20;

/** Clamp an integer into [min, max] (server-side range enforcement). */
export function clampInt(value: number, min: number, max: number): number {
  const n = Math.round(value);
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * A bounded integer slider field. Accepts any integer (a finite whole number;
 * a non-number / non-integer / NaN is a ParseError → 400) and CLAMPS it into
 * [min, max] via the decode transform, so the persisted value is always in range
 * regardless of what the client sends.
 */
const sliderField = (min: number, max: number) =>
  Schema.transform(Schema.Int, Schema.Int, {
    strict: true,
    decode: (n) => clampInt(n, min, max),
    encode: (n) => n,
  });

// ── Theme (per-section colours + fonts) ─────────────────────────────────────────

/**
 * The named sections an organiser can tone. Closed on purpose — same philosophy
 * as the image slots: a few well-placed sections, not a page-builder.
 */
export const THEME_SECTIONS = ["hero", "story", "details", "welcome"] as const;
export type ThemeSection = (typeof THEME_SECTIONS)[number];

/**
 * The font allow-list and the colour-scheme vocabulary both live in
 * `@cire/theme` — the single copy every side of the boundary imports. A
 * free-text font name/URL stays deliberately impossible (an arbitrary
 * `@font-face` on the static guest site is a render-blocking performance
 * footgun and a CSS/SSRF-injection surface), and a tone/preset key is likewise
 * bounded rather than free text.
 */
export { FONT_CHOICES, PALETTE_PRESET_KEYS, PALETTE_SEED_KEYS, SECTION_TONES };

const FontField = Schema.NullOr(Schema.Literal(...FONT_CHOICES));

/** Which derived surface a section sits on. `null` ⇒ the page ground. */
const ToneField = Schema.NullOr(Schema.Literal(...SECTION_TONES));

/**
 * Which curated scheme the organiser started from. Presentation only — the five
 * seeds are what actually render — so an unknown/stale key is harmless, but it
 * is still bounded so it can never carry free text into the builder's UI.
 */
const PresetField = Schema.NullOr(Schema.Literal(...PALETTE_PRESET_KEYS));

/**
 * Strict CSS-colour allow-list — the write-time half of the CSS-injection
 * gate. The single source of truth lives in `@cire/theme` (IB-S-L1) and is
 * shared with the guest site's render-time check, so the two sides cannot
 * drift.
 */
export const isThemeColor = isSafeCssColor;

// A nullable colour field: `null` clears back to the default token; a present
// value must pass the allow-list or the whole body is rejected with a 400.
const ColorField = Schema.NullOr(
  Schema.String.pipe(
    Schema.filter((s) => isThemeColor(s), {
      message: () => "Invalid colour (use hex, rgb(a), hsl(a) or oklch)",
    }),
  ),
);

/**
 * Full theme override body. Like the text body it's total — the builder always
 * submits every field, and a `null` clears that field back to the built-in
 * default token.
 *
 * The colour half is a five-seed SCHEME (migration 0044), not eight per-section
 * colours: the organiser names `ground` / `card` / `ink` / `gilt` / `bloom`, and
 * `derivePalette` in `@cire/theme` produces every other token from them. Each
 * seed still passes the same `isSafeCssColor` gate the per-section colours did —
 * the injection boundary is untouched, only the field count shrank. Section
 * identity now comes from a bounded per-section `tone`.
 */
export const InviteThemeBody = Schema.Struct({
  headingFont: FontField,
  bodyFont: FontField,
  // Which curated scheme the organiser started from (presentation only — the
  // five seeds are what render).
  palettePreset: PresetField,
  // The five seeds. `null` ⇒ fall back to that role's value in the default
  // preset, so a partly-filled scheme is always renderable.
  paletteGround: ColorField,
  paletteCard: ColorField,
  paletteInk: ColorField,
  paletteGilt: ColorField,
  paletteBloom: ColorField,
  // Which derived surface each section sits on (`null` ⇒ the page ground).
  heroTone: ToneField,
  storyTone: ToneField,
  detailsTone: ToneField,
  welcomeTone: ToneField,
  // Hero display sliders. Non-nullable bounded ints — the builder always submits
  // all three, each is clamped into range on decode (out-of-range is silently
  // clamped, not rejected), and a non-integer is a ParseError → 400. The
  // defaults (28 / 0 / 0) reproduce today's look.
  heroBlur: sliderField(HERO_BLUR_MIN, HERO_BLUR_MAX),
  titleBackdropOpacity: sliderField(TITLE_BACKDROP_OPACITY_MIN, TITLE_BACKDROP_OPACITY_MAX),
  titleBackdropBlur: sliderField(TITLE_BACKDROP_BLUR_MIN, TITLE_BACKDROP_BLUR_MAX),
});
export type InviteThemeBody = Schema.Schema.Type<typeof InviteThemeBody>;

/**
 * Body for `PUT /invite/design`. Deliberately just "a string" here — catalog
 * membership (and the premium entitlement) is checked in the route against
 * `@cire/invite-designs`, so an unknown id is a 422, not a 400.
 */
export const InviteDesignBody = Schema.Struct({
  designId: Schema.String,
});
export type InviteDesignBody = Schema.Schema.Type<typeof InviteDesignBody>;
