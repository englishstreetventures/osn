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
});
export type InviteTextBody = Schema.Schema.Type<typeof InviteTextBody>;

// ── Hero display options ────────────────────────────────────────────────────────

/**
 * How the hero backdrop image is rendered (organiser choice). `blurred` (default
 * — preserves today's look) requests the soft `hero-bg` variant; `regular`
 * requests the sharp full-bleed `hero` variant (no server blur). Closed union: it
 * bounds the DB column, the wire value, and the bounded variant the guest site
 * maps it to.
 */
export const HERO_IMAGE_STYLES = ["blurred", "regular"] as const;
export type HeroImageStyle = (typeof HERO_IMAGE_STYLES)[number];

/**
 * The legibility backdrop behind the hero title block. `none` (default) keeps
 * just the radial scrim — today's look; `solid` adds a translucent panel so the
 * title reads over a busy photo. Closed union, same rationale as above.
 */
export const HERO_TITLE_BACKDROPS = ["none", "solid"] as const;
export type HeroTitleBackdrop = (typeof HERO_TITLE_BACKDROPS)[number];

export function isHeroImageStyle(value: string): value is HeroImageStyle {
  return (HERO_IMAGE_STYLES as readonly string[]).includes(value);
}

export function isHeroTitleBackdrop(value: string): value is HeroTitleBackdrop {
  return (HERO_TITLE_BACKDROPS as readonly string[]).includes(value);
}

// ── Theme (per-section colours + fonts) ─────────────────────────────────────────

/**
 * The named sections an organiser can theme. Closed on purpose — same philosophy
 * as the image slots: a few well-placed sections, not a page-builder. Bounds the
 * theme columns and the CSS-variable namespace the guest site emits.
 */
export const THEME_SECTIONS = ["hero", "story", "details"] as const;
export type ThemeSection = (typeof THEME_SECTIONS)[number];

/**
 * Closed allow-list of fonts the guest site is willing to load. Free-text font
 * names / URLs are deliberately impossible: an arbitrary `@font-face`/Google-Fonts
 * URL on the static Astro guest site is both a performance footgun (render-block,
 * extra round-trips) and a CSS/SSRF-injection surface. Each entry maps to a
 * concrete CSS `font-family` stack on the guest side (`fontStack` below); the
 * value persisted + sent over the wire is only the bounded key. `"default"` (or
 * a null column) means "use the built-in token", so an un-themed invite renders
 * exactly as before.
 *
 *   serif fonts  → headings (display)      sans fonts → body
 * All are either already loaded by the guest site (Cormorant Garamond, Lato) or
 * resolve to a pure system-font stack — NO new web-font/CDN dependency is added.
 */
export const FONT_CHOICES = [
  "default",
  "cormorant", // Cormorant Garamond — the built-in display serif (already loaded)
  "lato", // Lato — the built-in body sans (already loaded)
  "georgia", // system serif stack
  "system-sans", // system sans stack
  "system-mono", // system monospace stack
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

export function isFontChoice(value: string): value is FontChoice {
  return (FONT_CHOICES as readonly string[]).includes(value);
}

const FontField = Schema.NullOr(Schema.Literal(...FONT_CHOICES));

/**
 * Strict CSS-colour allow-list, server-side twin of the guest site's
 * `isValidColor` (dress-code palette). Accepts only hex / rgb(a) / hsl(a) /
 * oklch forms with a restricted inner-character set — no named colours, no
 * `var(--…)`, no `url(...)`, no `expression(...)`. This is the security gate:
 * an organiser's colour string is interpolated into a guest-facing inline
 * `style`, so it must NEVER be persisted unvalidated (CSS-injection risk).
 */
const COLOR_INNER = "[\\d \\t,.%/+\\-a-zA-Z]*";
const COLOR_PATTERNS = [
  /^#[0-9a-fA-F]{3,8}$/,
  new RegExp(`^rgb\\(${COLOR_INNER}\\)$`),
  new RegExp(`^rgba\\(${COLOR_INNER}\\)$`),
  new RegExp(`^hsl\\(${COLOR_INNER}\\)$`),
  new RegExp(`^hsla\\(${COLOR_INNER}\\)$`),
  new RegExp(`^oklch\\(${COLOR_INNER}\\)$`),
];

export function isThemeColor(value: string): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return false;
  return COLOR_PATTERNS.some((pattern) => pattern.test(trimmed));
}

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
 * default token. Two global fonts plus an accent + surface colour per section.
 */
export const InviteThemeBody = Schema.Struct({
  headingFont: FontField,
  bodyFont: FontField,
  heroAccentColor: ColorField,
  heroSurfaceColor: ColorField,
  storyAccentColor: ColorField,
  storySurfaceColor: ColorField,
  detailsAccentColor: ColorField,
  detailsSurfaceColor: ColorField,
  // Hero display options. Non-nullable closed literals — the builder always
  // submits both, and an unknown value is a ParseError → 400 (never persisted).
  // `blurred`/`none` reproduce today's look, so they're the safe defaults the
  // organiser controls land on.
  heroImageStyle: Schema.Literal(...HERO_IMAGE_STYLES),
  heroTitleBackdrop: Schema.Literal(...HERO_TITLE_BACKDROPS),
});
export type InviteThemeBody = Schema.Schema.Type<typeof InviteThemeBody>;
