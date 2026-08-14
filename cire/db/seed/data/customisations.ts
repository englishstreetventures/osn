// Canonical invite customisation row for the sample wedding — the copy, images,
// palette, typography and per-section tones the guest site renders. Consumed
// only by cire/db/seed/generate.ts (the SQL seed); the in-memory API test seed
// deliberately leaves this table empty so the route tests keep exercising the
// "wedding has never been customised" defaults.
//
// A real wedding sets most of this within an hour of opening the builder, so a
// dev tier that leaves it NULL renders the built-in placeholder copy and no
// images at all — nothing like what production looks like. Every field below is
// therefore set, deliberately a SUPERSET of what the live wedding fills in, so
// the dev invite exercises every surface (footer note, welcome greeting, the
// details header, all three image slots, both hero crops).
//
// Column meanings and their validation ranges live in
// cire/db/src/schema.ts#weddingInviteCustomisations and
// cire/api/src/schemas/invite.ts. Values here must satisfy those validators —
// this seed writes SQL directly and so bypasses them.

import type { SeedCrop } from "./events";

export type SeedCustomisation = {
  readonly heroTitle: string;
  readonly heroSubtitle: string;
  readonly storyEyebrow: string;
  readonly storyHeading: string;
  readonly storyBody: string;
  readonly detailsEyebrow: string;
  readonly detailsHeading: string;
  readonly welcomeMessage: string;
  readonly footerMessage: string;
  // R2 object KEYS, same `assets/<weddingId>/<slot>-<uuid>` namespace the upload
  // endpoint mints. Pinned so the bytes survive every DB reset — upload them
  // once per tier with `bun run --cwd cire/db assets:seed:dev`.
  readonly heroImageKey: string;
  readonly storyImageKey: string;
  readonly footerImageKey: string;
  readonly heroImageCrop: SeedCrop;
  // The hero renders full-bleed, so it carries a SECOND crop the guest site
  // applies below the desktop breakpoint (a tall slice of the same source).
  readonly heroImageCropMobile: SeedCrop;
  readonly storyImageCrop: SeedCrop;
  readonly footerImageCrop: SeedCrop;
  readonly heroBlur: number;
  readonly heroTitleBackdropOpacity: number;
  readonly heroTitleBackdropBlur: number;
  readonly themeHeadingFont: string;
  readonly themeBodyFont: string;
  readonly themeHeadingSize: string;
  readonly themeHeadingWeight: string;
  readonly themeHeadingStyle: string;
  readonly themeBodyWeight: string;
  readonly themeBodyStyle: string;
  readonly palettePreset: string;
  readonly paletteGround: string;
  readonly paletteCard: string;
  readonly paletteInk: string;
  readonly paletteGilt: string;
  readonly paletteBloom: string;
  readonly heroTone: string;
  readonly storyTone: string;
  readonly detailsTone: string;
  readonly welcomeTone: string;
  readonly inviteMessage: string;
  readonly designId: string;
};

export const customisation = {
  heroTitle: "Ada & Kit",
  heroSubtitle: "25 November 2026 · Sydney",
  storyEyebrow: "Our Story",
  storyHeading: "How we got here",
  storyBody:
    "We met in a queue for terrible coffee, argued about the coffee, and have been arguing happily ever since. Ten years, three cities and one very opinionated cat later, we would love you with us for the week we make it official.",
  detailsEyebrow: "Celebrate With Us",
  detailsHeading: "Your Events",
  welcomeMessage:
    "We are so glad you are here. Everything below is just for you — only the events you are invited to are shown.",
  footerMessage: "No boxed gifts, please. Your being there is the whole point.",
  // Slot keys mirror the upload endpoint's naming (hero / story / footer).
  heroImageKey: "assets/wed_bootstrap/hero-e0000000-0000-4000-8000-000000000001",
  storyImageKey: "assets/wed_bootstrap/story-e0000000-0000-4000-8000-000000000002",
  footerImageKey: "assets/wed_bootstrap/footer-e0000000-0000-4000-8000-000000000003",
  heroImageCrop: { x: 0, y: 0.08, w: 1, h: 0.62 },
  heroImageCropMobile: { x: 0.22, y: 0, w: 0.56, h: 1 },
  storyImageCrop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  footerImageCrop: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
  // 5, not the 28 default: the sharper hero is what a wedding that has been
  // through the builder actually looks like.
  heroBlur: 5,
  heroTitleBackdropOpacity: 22,
  heroTitleBackdropBlur: 6,
  // Keys from @cire/theme's closed enums (FONT_CHOICES, HEADING_SIZE_CHOICES,
  // FONT_WEIGHT_CHOICES, FONT_STYLE_CHOICES) — never free-text CSS.
  themeHeadingFont: "cormorant",
  themeBodyFont: "lato",
  themeHeadingSize: "large",
  themeHeadingWeight: "light",
  themeHeadingStyle: "default",
  themeBodyWeight: "regular",
  themeBodyStyle: "default",
  // The five seeds every other colour derives from. These are PALETTE_PRESETS.fog
  // verbatim, with the preset key recorded so the builder shows it selected.
  palettePreset: "fog",
  paletteGround: "oklch(96.5% 0.004 250)",
  paletteCard: "oklch(99.2% 0.002 250)",
  paletteInk: "oklch(29% 0.016 255)",
  paletteGilt: "oklch(52% 0.042 250)",
  paletteBloom: "oklch(50% 0.072 215)",
  // Alternating surfaces down the page — what carries section identity now that
  // colour is global. Values from SECTION_TONES.
  heroTone: "ground",
  storyTone: "card",
  detailsTone: "card",
  welcomeTone: "raised",
  inviteMessage: "You're invited! Here are your details for our wedding week:",
  designId: "classic",
} as const satisfies SeedCustomisation;
