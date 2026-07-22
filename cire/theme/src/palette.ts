/**
 * The invite colour scheme: **five seeds in, the whole page out.**
 *
 * The builder used to ask an organiser for eight independent colours — an
 * accent and a surface for each of hero / story / welcome / events — which is
 * eight chances to pick a set that doesn't hang together, and which still only
 * reached five of the guest site's thirteen design tokens. Everything else
 * (page background, borders, text, muted text, the hero gradient) was locked.
 *
 * A scheme inverts that. The organiser names five colours by their role in the
 * invite, and every other colour is DERIVED here, once, by a pure function that
 * the API, the guest site and the organiser's preview all import. Fewer
 * decisions, wider coverage, and — because derivation is shared — a preview
 * that cannot disagree with what a guest sees.
 *
 * Section identity does not come from per-section colour any more. It comes
 * from {@link SECTION_TONES}: which of the derived surfaces a section sits on.
 * Alternating ground / card down the page is what makes sections read as
 * distinct; eight free colours were never what did that work.
 */

import {
  contrastOklch,
  ensureContrast,
  formatOklch,
  type Oklch,
  parseColor,
  shiftLightness,
  WCAG_TEXT_MIN,
  WCAG_UI_MIN,
  withAlpha,
} from "./color";

// ── Seeds ─────────────────────────────────────────────────────────────────────

/**
 * The five colours an organiser actually chooses. Named for their job on the
 * invite rather than `primary`/`secondary`, because these names are what the
 * builder shows them.
 *
 * Five is the smallest set that still works:
 *  - `card` must be independent of `ground` — "dark page, lit cards" and "cream
 *    page, white cards" are different designs, not one design at two
 *    lightnesses.
 *  - `bloom` must be independent of `gilt` — without a second chromatic colour
 *    every template reads metallic, and there is nothing to give timeline dots,
 *    ornament and ambient light their own voice.
 * Four collapses one of those pairs; six starts asking for distinctions the
 * organiser cannot see on the page.
 */
export interface PaletteSeeds {
  /** The page itself — body background, hero base, scrims. */
  ground: string;
  /** Raised paper — event cards, modals, panels, the code-entry box. */
  card: string;
  /** Everything written — headings, body, muted text, hairlines. */
  ink: string;
  /** The metal — rules, eyebrows, buttons, links, focus ring. */
  gilt: string;
  /** The festive counter-colour — dots, ornament, motifs, ambient light. */
  bloom: string;
}

export const PALETTE_SEED_KEYS = ["ground", "card", "ink", "gilt", "bloom"] as const;
export type PaletteSeedKey = (typeof PALETTE_SEED_KEYS)[number];

// ── Presets ───────────────────────────────────────────────────────────────────

/**
 * Curated schemes, so the common path is one click and zero colour decisions.
 * Keys are shared with the invite-template registry (see
 * `cire/wiki/architecture/invite-templates.md`) so a template can name its
 * default scheme; picking a preset and then nudging one seed re-derives the
 * rest, so the result stays coherent by construction.
 *
 * Adding a scheme is a data change — the same bounded-allow-list philosophy as
 * `INVITE_IMAGE_SLOTS` and `FONT_CHOICES`.
 */
export const PALETTE_PRESETS = {
  /**
   * The built-in look — deep evergreen ground, gold metal. `ground`, `card`,
   * `ink` and `gilt` are the literal values of today's `@theme` tokens, so an
   * invite on this preset renders as the product always has.
   */
  evergreen: {
    ground: "oklch(19.96% 0.0331 147.34)",
    card: "oklch(22.7% 0.0275 152.78)",
    ink: "oklch(94.62% 0.0111 89.72)",
    gilt: "oklch(74.99% 0.0854 82.08)",
    bloom: "oklch(70.5% 0.1123 24.5)",
  },
  /** Ceremonial and dark: aubergine night, gold, marigold. Pairs with `hindu-jewel`. */
  jewel: {
    ground: "oklch(19.5% 0.045 305)",
    card: "oklch(25.5% 0.052 300)",
    ink: "oklch(95.5% 0.014 85)",
    gilt: "oklch(78% 0.098 84)",
    bloom: "oklch(74% 0.163 62)",
  },
  /** Bright and restrained: paper white, slate ink, a cool grey-blue accent. Pairs with `minimal`. */
  fog: {
    ground: "oklch(96.5% 0.004 250)",
    card: "oklch(99.2% 0.002 250)",
    ink: "oklch(29% 0.016 255)",
    gilt: "oklch(52% 0.042 250)",
    bloom: "oklch(63% 0.072 215)",
  },
  /** Warm and traditional: candle-cream ground, brass, sage. */
  chapel: {
    ground: "oklch(94.5% 0.014 85)",
    card: "oklch(98.5% 0.008 85)",
    ink: "oklch(28% 0.018 70)",
    gilt: "oklch(58% 0.079 76)",
    bloom: "oklch(60% 0.058 145)",
  },
  /** Garden party: blush ground, white paper, plum ink, olive bloom. */
  garden: {
    ground: "oklch(93.5% 0.021 25)",
    card: "oklch(98.8% 0.006 25)",
    ink: "oklch(30% 0.052 350)",
    gilt: "oklch(57% 0.101 15)",
    bloom: "oklch(58% 0.068 128)",
  },
} as const satisfies Record<string, PaletteSeeds>;

export type PalettePresetKey = keyof typeof PALETTE_PRESETS;

export const PALETTE_PRESET_KEYS = Object.keys(PALETTE_PRESETS) as PalettePresetKey[];

/** The scheme an invite falls back to when the organiser has picked nothing. */
export const DEFAULT_PRESET: PalettePresetKey = "evergreen";

export function isPalettePresetKey(value: string): value is PalettePresetKey {
  return Object.hasOwn(PALETTE_PRESETS, value);
}

// ── Section tone ──────────────────────────────────────────────────────────────

/**
 * Which derived surface a section sits on. Replaces the per-section surface
 * picker: three named steps in one family always read as a deliberate rhythm,
 * where three freely-chosen colours usually do not.
 *
 * Deliberately excludes an inverted "sit on the accent" tone — that needs the
 * text tokens to flip too, and a half-flipped section is exactly the kind of
 * unreadable output the derivation exists to prevent.
 */
export const SECTION_TONES = ["ground", "card", "raised"] as const;
export type SectionTone = (typeof SECTION_TONES)[number];

export const DEFAULT_SECTION_TONE: SectionTone = "ground";

export function isSectionTone(value: string): value is SectionTone {
  return (SECTION_TONES as readonly string[]).includes(value);
}

/** The derived token each tone points a section's background at. */
const TONE_TOKEN: Record<SectionTone, string> = {
  ground: "var(--color-bg)",
  card: "var(--color-surface)",
  raised: "var(--color-surface-raised)",
};

/**
 * The style map a section wrapper applies for its tone. One variable — the
 * section paints `background-color: var(--invite-section-bg)` and inherits
 * every other token from the palette root.
 */
export function sectionToneVars(tone: SectionTone | null | undefined): Record<string, string> {
  const key = tone && isSectionTone(tone) ? tone : DEFAULT_SECTION_TONE;
  return { "--invite-section-bg": TONE_TOKEN[key] };
}

// ── Fonts ─────────────────────────────────────────────────────────────────────

/**
 * Closed allow-list of fonts the guest site will load, and the concrete stack
 * each key resolves to. Only the KEY is ever persisted or sent over the wire —
 * free-text font names are deliberately impossible (an arbitrary `@font-face`
 * URL on the static guest site is both a render-blocking performance footgun
 * and a CSS/SSRF-injection surface).
 *
 * No new web font is introduced: Cormorant Garamond and Lato are already loaded
 * by the guest document, everything else is a pure system stack.
 *
 * This map used to exist in three hand-maintained copies (guest render, API
 * enum, organiser preview). One copy is the point.
 */
export const FONT_STACKS = {
  cormorant: '"Cormorant Garamond", Georgia, serif',
  lato: '"Lato", system-ui, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "system-mono": 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
} as const satisfies Record<string, string>;

/**
 * `"default"` plus every stack key — the persisted enum. Spelled out rather
 * than derived from `FONT_STACKS` so the literal union survives into the API's
 * `Schema.Literal(...)`; the test below locks the two together.
 */
export const FONT_CHOICES = [
  "default",
  "cormorant",
  "lato",
  "georgia",
  "system-sans",
  "system-mono",
] as const;
export type FontChoice = (typeof FONT_CHOICES)[number];

/** Every stack key is a valid choice, and every non-default choice has a stack. */
export function fontChoiceHasStack(choice: FontChoice): boolean {
  return choice === "default" || Object.hasOwn(FONT_STACKS, choice);
}

/** Resolve a font-choice key to its CSS stack, or `null` to keep the default. */
export function fontStack(choice: string | null | undefined): string | null {
  if (!choice || choice === "default") return null;
  return (FONT_STACKS as Record<string, string>)[choice] ?? null;
}

// ── Derivation ────────────────────────────────────────────────────────────────

/**
 * Every custom property {@link derivePalette} emits. Exported so the guest
 * site's style sink can allow-list exactly these names (S-L1: a caller wiring
 * unvalidated data into a `style` must not be able to smuggle in an arbitrary
 * CSS property) and so a test can assert the two sides agree.
 */
export const DERIVED_TOKENS = [
  // Global design tokens the Tailwind utilities consume (mirrors `@theme`).
  "--color-bg",
  "--color-surface",
  "--color-surface-raised",
  "--color-border",
  "--color-text",
  "--color-text-muted",
  "--color-gold",
  "--color-gold-dim",
  "--color-bloom",
  "--color-bloom-dim",
  "--color-error",
  "--color-success",
  // Invite-specific compositions that used to be hardcoded literals.
  "--invite-hero-grad-1",
  "--invite-hero-grad-2",
  "--invite-hero-grad-3",
  "--invite-scrim-from",
  "--invite-scrim-to",
  "--invite-panel",
  "--invite-card-edge",
  "--invite-focus",
] as const;

export type DerivedToken = (typeof DERIVED_TOKENS)[number];

/** Shortest-arc hue interpolation, so a mix never sweeps the long way round. */
function mix(a: Oklch, b: Oklch, t: number): Oklch {
  let dh = b.h - a.h;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  return {
    l: a.l + (b.l - a.l) * t,
    c: a.c + (b.c - a.c) * t,
    h: (((a.h + dh * t) % 360) + 360) % 360,
    a: a.a + (b.a - a.a) * t,
  };
}

/**
 * Parse a seed, falling back to the chosen preset's value for that role (or the
 * default preset's, when no preset was chosen).
 *
 * The fallback has to honour `preset`, not just the default. An organiser who
 * picks a scheme and changes nothing saves the KEY with five null seeds — if a
 * null seed resolved to the default preset here, every preset would render as
 * the built-in look to guests while previewing correctly in the builder.
 */
function seed(
  value: string | null | undefined,
  role: PaletteSeedKey,
  preset: PalettePresetKey,
): Oklch {
  const parsed = value ? parseColor(value) : null;
  return parsed ?? (parseColor(PALETTE_PRESETS[preset][role]) as Oklch);
}

/** The preset a scheme is based on — the default when absent or unrecognised. */
function basePreset(preset: string | null | undefined): PalettePresetKey {
  return preset && isPalettePresetKey(preset) ? preset : DEFAULT_PRESET;
}

/**
 * The five colours a scheme resolves to: the organiser's own picks laid over
 * the preset they started from. This is the single definition of "what does
 * this scheme actually mean" — the guest render, the organiser preview and the
 * contrast report all go through it.
 */
export function resolveSeeds(
  seeds: Partial<PaletteSeeds> | null | undefined,
  preset?: string | null,
): PaletteSeeds {
  const base = PALETTE_PRESETS[basePreset(preset)];
  return {
    ground: seeds?.ground ?? base.ground,
    card: seeds?.card ?? base.card,
    ink: seeds?.ink ?? base.ink,
    gilt: seeds?.gilt ?? base.gilt,
    bloom: seeds?.bloom ?? base.bloom,
  };
}

/**
 * The hero scrim at a given alpha: the page's own hue driven to whichever
 * extreme the page itself sits near, so it deepens a dark invite and veils a
 * light one instead of greying it.
 */
function scrim(ground: Oklch, alpha: number): Oklch {
  const dark = ground.l < 0.5;
  return { l: dark ? 0.08 : 0.97, c: ground.c * 0.4, h: ground.h, a: alpha };
}

/**
 * A semantic colour (error / success) rebuilt for this palette: the hue is
 * FIXED — red means wrong everywhere, and re-hueing it to match a scheme would
 * be a lie — but its lightness is retargeted so it stays legible on both a
 * near-black ground and a cream one.
 */
function semantic(hue: number, chroma: number, card: Oklch): string {
  const start: Oklch = { l: card.l < 0.5 ? 0.72 : 0.48, c: chroma, h: hue, a: 1 };
  return formatOklch(ensureContrast(start, card, WCAG_TEXT_MIN));
}

/**
 * Derive the full token set from a scheme: five seeds laid over the preset they
 * were chosen from.
 *
 * Two rules run through all of it:
 *
 * 1. **Direction, not absolutes.** Derived surfaces move AWAY from `ground`'s
 *    lightness rather than "lighter" or "darker", so one function produces a
 *    coherent dark invite and a coherent light one with no `isDark` flag
 *    threaded through the components.
 * 2. **Contrast is enforced, not advised.** Text and accent tokens are nudged
 *    until they clear WCAG on the surfaces they actually sit on. The organiser
 *    can still choose any five colours; the invite cannot come out unreadable.
 *    A well-chosen palette is returned untouched.
 */
export function derivePalette(
  seeds: Partial<PaletteSeeds> | null | undefined,
  preset?: string | null,
): Record<string, string> {
  const base = basePreset(preset);
  const ground = seed(seeds?.ground, "ground", base);
  const card = seed(seeds?.card, "card", base);
  const inkSeed = seed(seeds?.ink, "ink", base);
  const giltSeed = seed(seeds?.gilt, "gilt", base);
  const bloomSeed = seed(seeds?.bloom, "bloom", base);

  // A raised surface is one step further from the page than a card is. When an
  // organiser picks a card on the far side of ground, "away" keeps going that
  // way; a card on the near side (a dark card on a pale page) keeps going that
  // way instead — so the three surfaces always stack in a consistent order.
  //
  // Unless there's no room. A near-white card on a cream page has nowhere
  // lighter to go: clamping would land raised ON white, indistinguishable from
  // the card, and the "raised" tone would silently stop being a third surface.
  // So when the step would clip, take it the other way — a slightly darker
  // panel still reads as a distinct surface, which is the whole job.
  const STEP = 0.05;
  const away = card.l >= ground.l ? 1 : -1;
  const clips = card.l + away * STEP > 1 || card.l + away * STEP < 0;
  const raised = shiftLightness(card, (clips ? -away : away) * STEP);

  // Text sits on ground AND card, so it must clear the harder of the two.
  const onCard = ensureContrast(inkSeed, card, WCAG_TEXT_MIN);
  const ink = ensureContrast(onCard, ground, WCAG_TEXT_MIN);
  // Muted text is ink walked a third of the way toward the page, then held to
  // the UI minimum — legible, clearly secondary, and never the alpha-washed
  // near-invisible grey a flat 50% opacity produces on a light scheme.
  const muted = ensureContrast(mix(ink, ground, 0.34), card, WCAG_UI_MIN);

  // Gold carries large display text, rules and buttons; hold it to the UI
  // minimum rather than the text minimum so a genuinely gold gold survives
  // instead of being bleached into a cream.
  const gilt = ensureContrast(giltSeed, ground, WCAG_UI_MIN);
  const bloom = ensureContrast(bloomSeed, ground, WCAG_UI_MIN);

  return {
    "--color-bg": formatOklch(ground),
    "--color-surface": formatOklch(card),
    "--color-surface-raised": formatOklch(raised),
    "--color-border": formatOklch(withAlpha(ink, 0.12)),
    "--color-text": formatOklch(ink),
    "--color-text-muted": formatOklch(muted),
    "--color-gold": formatOklch(gilt),
    // The built-in dim gold is gold at 0.35 alpha; keep that exact relationship.
    "--color-gold-dim": formatOklch(withAlpha(gilt, 0.35)),
    "--color-bloom": formatOklch(bloom),
    "--color-bloom-dim": formatOklch(withAlpha(bloom, 0.3)),
    "--color-error": semantic(21.48, 0.1401, card),
    "--color-success": semantic(146.94, 0.1421, card),

    // Hero base gradient — three stops walked across the palette's own
    // surfaces, replacing a hardcoded evergreen `linear-gradient` that ignored
    // the organiser's colours entirely (and was duplicated in the builder).
    "--invite-hero-grad-1": formatOklch(raised),
    "--invite-hero-grad-2": formatOklch(ground),
    "--invite-hero-grad-3": formatOklch(card),
    // Scrim over the hero photo — it exists so the title survives whatever
    // photo is behind it. It therefore has to track the PAGE: a dark scheme
    // scrims dark (as the built-in invite always has), and a light scheme
    // scrims LIGHT — a veil that washes the photo toward the page colour so
    // dark text still reads. A fixed dark scrim turns a cream invite grey,
    // which is what the first cut of this did.
    "--invite-scrim-from": formatOklch(scrim(ground, 0.3)),
    "--invite-scrim-to": formatOklch(scrim(ground, 0.55)),
    // The hero title legibility panel. Previously fell back to pure black even
    // on a light invite; now it is the palette's own card colour.
    "--invite-panel": formatOklch(card),
    // The lit top edge on raised surfaces (templates' Layer 3).
    "--invite-card-edge": formatOklch(withAlpha(gilt, 0.4)),
    // Focus ring — must clear 3:1 against the page or it is not an indicator.
    "--invite-focus": formatOklch(ensureContrast(gilt, ground, WCAG_UI_MIN)),
  };
}

/**
 * A readable report of which derived tokens had to be moved to stay legible,
 * for the builder to show ("ink lightened to stay readable on your card
 * colour"). Empty when the organiser's five colours already work — which is the
 * signal that no explaining is needed.
 */
export interface PaletteAdjustment {
  token: string;
  reason: string;
}

export function paletteAdjustments(
  seeds: Partial<PaletteSeeds> | null | undefined,
  preset?: string | null,
): PaletteAdjustment[] {
  const base = basePreset(preset);
  const ground = seed(seeds?.ground, "ground", base);
  const card = seed(seeds?.card, "card", base);
  const out: PaletteAdjustment[] = [];

  const inkSeed = seed(seeds?.ink, "ink", base);
  if (
    contrastOklch(inkSeed, card) < WCAG_TEXT_MIN ||
    contrastOklch(inkSeed, ground) < WCAG_TEXT_MIN
  ) {
    out.push({
      token: "ink",
      reason: "Adjusted to stay readable on your page and card colours.",
    });
  }

  const giltSeed = seed(seeds?.gilt, "gilt", base);
  if (contrastOklch(giltSeed, ground) < WCAG_UI_MIN) {
    out.push({ token: "gilt", reason: "Adjusted so buttons and rules stay visible." });
  }

  const bloomSeed = seed(seeds?.bloom, "bloom", base);
  if (contrastOklch(bloomSeed, ground) < WCAG_UI_MIN) {
    out.push({ token: "bloom", reason: "Adjusted so accents stay visible on the page." });
  }

  return out;
}
