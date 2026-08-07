/**
 * Invite-builder data model: the wire types, the closed option sets (labelled
 * mirrors of the `@cire/theme` enums), the editable draft shape, and the pure
 * payload builders the save action serialises. No JSX and no signals — the
 * orchestrator (`InviteBuilder.tsx`) owns all state; everything here is data
 * and pure functions so the payload contract stays testable and drift-proof.
 */

import {
  FONT_CHOICES,
  FONT_STYLE_CHOICES,
  FONT_WEIGHT_CHOICES,
  HEADING_SIZE_CHOICES,
  type PalettePresetKey,
  type SectionTone,
} from "@cire/theme";

import type { ImageCrop } from "../../lib/image-crop";
import type { PaletteState } from "../PaletteField";

/** The four sections whose tone an organiser chooses. */
export type ThemeSection = "hero" | "story" | "details" | "welcome";

export type ImageSlot = "hero" | "story" | "footer";

/**
 * The font choices, labelled for the dropdown. The KEYS come from the shared
 * allow-list in `@cire/theme`, so this can no longer drift from what the API
 * accepts or the guest site can render — only the labels live here.
 */
const FONT_LABELS: Record<string, string> = {
  default: "Default",
  cormorant: "Cormorant (serif)",
  lato: "Lato (sans)",
  georgia: "Georgia (serif)",
  "system-sans": "System sans",
  "system-mono": "System mono",
};
export const FONT_OPTIONS = FONT_CHOICES.map((value) => ({
  value,
  label: FONT_LABELS[value] ?? value,
}));

/**
 * Typography-option dropdowns (0048). Same shape as the fonts: the KEYS come
 * from the closed enums in `@cire/theme`, only the labels live here. "Default"
 * always means "whatever the design pack does".
 */
const label = (value: string, labels: Record<string, string>) => ({
  value,
  label: labels[value] ?? value,
});
export const HEADING_SIZE_OPTIONS = HEADING_SIZE_CHOICES.map((v) =>
  label(v, { default: "Default", small: "Small", large: "Large" }),
);
export const FONT_WEIGHT_OPTIONS = FONT_WEIGHT_CHOICES.map((v) =>
  label(v, { default: "Default", light: "Light", regular: "Regular", bold: "Bold" }),
);
export const FONT_STYLE_OPTIONS = FONT_STYLE_CHOICES.map((v) =>
  label(v, { default: "Default", normal: "Normal", italic: "Italic" }),
);

export interface InviteTheme {
  headingFont: string | null;
  bodyFont: string | null;
  // Global typography options (0048). Optional on the wire so a mid-deploy
  // payload from an older API seeds them as "default" instead of crashing.
  headingSize?: string | null;
  headingWeight?: string | null;
  headingStyle?: string | null;
  bodyWeight?: string | null;
  bodyStyle?: string | null;
  /** Which curated scheme the organiser started from. */
  palettePreset: string | null;
  /** The five colour seeds; every other colour is derived from them. */
  palette: Partial<Record<"ground" | "card" | "ink" | "gilt" | "bloom", string | null>>;
  /** Which derived surface each section sits on. */
  tones: Partial<Record<ThemeSection, string | null>>;
}

// Hero display sliders (organiser choice; migration 0018 replaced the coarse
// enums). The API coalesces a missing row to these today's-look defaults:
//   blur 28 (soft backdrop) / title backdrop opacity 0, blur 0 (no panel).
export interface HeroDisplay {
  blur: number;
  titleBackdrop: { opacity: number; blur: number };
}

// Slider ranges — mirror the clamp bounds in cire/api schemas/invite.ts.
export const HERO_BLUR_MIN = 0;
export const HERO_BLUR_MAX = 40;
export const HERO_BLUR_DEFAULT = 28;
export const BACKDROP_OPACITY_MIN = 0;
export const BACKDROP_OPACITY_MAX = 100;
export const BACKDROP_BLUR_MIN = 0;
export const BACKDROP_BLUR_MAX = 20;

export interface InviteCustomisation {
  hero: {
    title: string | null;
    subtitle: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
    // Phone-specific hero crop (0046) — the guest site applies it below its
    // desktop breakpoint. Optional so a mid-deploy payload from an older API
    // reads as "no phone crop" instead of crashing the builder.
    imageCropMobile?: ImageCrop | null;
  };
  story: {
    eyebrow: string | null;
    heading: string | null;
    body: string | null;
    imageUrl: string | null;
    imageCrop: ImageCrop | null;
  };
  // Events-section header copy + post-claim welcome greeting (migration 0028).
  // Optional on the wire so a mid-deploy payload from an older API seeds the
  // fields as "use the defaults" instead of crashing the builder.
  details?: { eyebrow: string | null; heading: string | null };
  welcome?: { message: string | null };
  // Footer closing note (0049) + its optional image (0050). Optional on the wire
  // for the same mid-deploy reason; unlike the fields above neither has a
  // built-in default, so absent simply means the guest footer shows neither.
  footer?: { message: string | null; imageUrl?: string | null; imageCrop?: ImageCrop | null };
  heroDisplay: HeroDisplay;
  theme: InviteTheme;
  // Optional host override for the first line of the copyable invite message
  // (the line above the auto-appended guest-site URL + family code).
  inviteMessage: string | null;
  designId?: string;
}

/** Whether a catalog design is locked for this wedding (premium without the
 *  `premium_templates` entitlement). The server enforces this regardless —
 *  this only drives the aria-disabled state + lock badge. */
export function isDesignLocked(tier: "free" | "premium", entitlements: readonly string[]): boolean {
  return tier === "premium" && !entitlements.includes("premium_templates");
}

/** A "default" font selection collapses to null (keep the built-in token). */
export function fontOrDefault(value: string): string | null {
  return value === "default" ? null : value;
}

// The built-in default copy, shown as placeholders so an organiser can see what
// they're overriding. Mirrors the guest site's neutral hardcoded fallbacks.
export const DEFAULTS = {
  heroTitle: "You're Invited",
  heroSubtitle: "We can't wait to celebrate with you",
  storyEyebrow: "Our Story",
  storyHeading: "How It All Began",
  storyBody:
    "Every love story is beautiful, and we can't wait to celebrate the next chapter of ours with the people we love most…",
  detailsEyebrow: "Celebrate With Us",
  detailsHeading: "Your Events",
  welcomeMessage: "We are delighted to invite you to celebrate with us.",
};

/**
 * Per-field character caps — a client-side mirror of `InviteTextBody` in
 * `cire/api/src/schemas/invite.ts`, so the organiser hits a live counter
 * instead of a 400 at save time. Keep in lockstep with the server schema.
 */
export const COPY_CAPS = {
  heroTitle: 120,
  heroSubtitle: 200,
  storyEyebrow: 80,
  storyHeading: 160,
  storyBody: 4000,
  detailsEyebrow: 80,
  detailsHeading: 160,
  welcomeMessage: 300,
  footerMessage: 300,
  inviteMessage: 600,
} as const;

/** Human-readable slot names for the upload toasts + remove confirms. */
export const SLOT_LABELS: Record<ImageSlot, string> = {
  hero: "Hero",
  story: "Story",
  footer: "Closing",
};

/** Trimmed live copy (or the default when blank), truncated to fit a preview card. */
export function sampleCopy(value: string, fallback: string, max = 90): string {
  const text = value.trim().length > 0 ? value.trim() : fallback;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * The organiser's full editable state, held in ONE `createStore` draft. All
 * the copy buffers, theme picks and hero-display sliders live here; the two
 * payload builders below serialise it, and dirty-checking is a memoised
 * comparison of those serialisations against the last server-acknowledged
 * snapshot — which is what lets the save bar show live "Unsaved changes"
 * state (the old signal-per-field + non-reactive snapshot shape could not).
 */
export interface InviteDraft {
  heroTitle: string;
  heroSubtitle: string;
  storyEyebrow: string;
  storyHeading: string;
  storyBody: string;
  detailsEyebrow: string;
  detailsHeading: string;
  welcomeMessage: string;
  footerMessage: string;
  inviteMessage: string;
  headingFont: string;
  bodyFont: string;
  headingSize: string;
  headingWeight: string;
  headingStyle: string;
  bodyWeight: string;
  bodyStyle: string;
  palette: PaletteState;
  tones: Record<ThemeSection, SectionTone | null>;
  heroBlur: number;
  titleBackdropOpacity: number;
  titleBackdropBlur: number;
}

export function emptyDraft(): InviteDraft {
  return {
    heroTitle: "",
    heroSubtitle: "",
    storyEyebrow: "",
    storyHeading: "",
    storyBody: "",
    detailsEyebrow: "",
    detailsHeading: "",
    welcomeMessage: "",
    footerMessage: "",
    inviteMessage: "",
    headingFont: "default",
    bodyFont: "default",
    headingSize: "default",
    headingWeight: "default",
    headingStyle: "default",
    bodyWeight: "default",
    bodyStyle: "default",
    palette: { preset: null, seeds: {} },
    tones: { hero: null, story: null, details: null, welcome: null },
    heroBlur: HERO_BLUR_DEFAULT,
    titleBackdropOpacity: 0,
    titleBackdropBlur: 0,
  };
}

/** The draft a loaded customisation seeds — the old per-signal `seed()`, as data. */
export function draftFromCustomisation(d: InviteCustomisation): InviteDraft {
  return {
    heroTitle: d.hero.title ?? "",
    heroSubtitle: d.hero.subtitle ?? "",
    storyEyebrow: d.story.eyebrow ?? "",
    storyHeading: d.story.heading ?? "",
    storyBody: d.story.body ?? "",
    detailsEyebrow: d.details?.eyebrow ?? "",
    detailsHeading: d.details?.heading ?? "",
    welcomeMessage: d.welcome?.message ?? "",
    footerMessage: d.footer?.message ?? "",
    inviteMessage: d.inviteMessage ?? "",
    headingFont: d.theme.headingFont ?? "default",
    bodyFont: d.theme.bodyFont ?? "default",
    headingSize: d.theme.headingSize ?? "default",
    headingWeight: d.theme.headingWeight ?? "default",
    headingStyle: d.theme.headingStyle ?? "default",
    bodyWeight: d.theme.bodyWeight ?? "default",
    bodyStyle: d.theme.bodyStyle ?? "default",
    palette: {
      preset: (d.theme.palettePreset as PalettePresetKey | null) ?? null,
      seeds: {
        ground: d.theme.palette?.ground ?? null,
        card: d.theme.palette?.card ?? null,
        ink: d.theme.palette?.ink ?? null,
        gilt: d.theme.palette?.gilt ?? null,
        bloom: d.theme.palette?.bloom ?? null,
      },
    },
    tones: {
      hero: (d.theme.tones?.hero as SectionTone | null) ?? null,
      story: (d.theme.tones?.story as SectionTone | null) ?? null,
      details: (d.theme.tones?.details as SectionTone | null) ?? null,
      welcome: (d.theme.tones?.welcome as SectionTone | null) ?? null,
    },
    heroBlur: d.heroDisplay?.blur ?? HERO_BLUR_DEFAULT,
    titleBackdropOpacity: d.heroDisplay?.titleBackdrop?.opacity ?? 0,
    titleBackdropBlur: d.heroDisplay?.titleBackdrop?.blur ?? 0,
  };
}

/** The `/invite/text` request body from the draft. */
export function textPayload(draft: InviteDraft) {
  return {
    heroTitle: draft.heroTitle || null,
    heroSubtitle: draft.heroSubtitle || null,
    storyEyebrow: draft.storyEyebrow || null,
    storyHeading: draft.storyHeading || null,
    storyBody: draft.storyBody || null,
    detailsEyebrow: draft.detailsEyebrow || null,
    detailsHeading: draft.detailsHeading || null,
    welcomeMessage: draft.welcomeMessage || null,
    footerMessage: draft.footerMessage || null,
    inviteMessage: draft.inviteMessage || null,
  };
}

/** The `/invite/theme` request body from the draft. */
export function themePayload(draft: InviteDraft) {
  return {
    headingFont: fontOrDefault(draft.headingFont),
    bodyFont: fontOrDefault(draft.bodyFont),
    headingSize: fontOrDefault(draft.headingSize),
    headingWeight: fontOrDefault(draft.headingWeight),
    headingStyle: fontOrDefault(draft.headingStyle),
    bodyWeight: fontOrDefault(draft.bodyWeight),
    bodyStyle: fontOrDefault(draft.bodyStyle),
    palettePreset: draft.palette.preset,
    paletteGround: draft.palette.seeds.ground ?? null,
    paletteCard: draft.palette.seeds.card ?? null,
    paletteInk: draft.palette.seeds.ink ?? null,
    paletteGilt: draft.palette.seeds.gilt ?? null,
    paletteBloom: draft.palette.seeds.bloom ?? null,
    heroTone: draft.tones.hero,
    storyTone: draft.tones.story,
    detailsTone: draft.tones.details,
    welcomeTone: draft.tones.welcome,
    heroBlur: draft.heroBlur,
    titleBackdropOpacity: draft.titleBackdropOpacity,
    titleBackdropBlur: draft.titleBackdropBlur,
  };
}
