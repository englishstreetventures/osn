/**
 * The contract's token names, as data.
 *
 * `tokens.css` is the authority on what the contract *is*; this module exists
 * so a mapping can be checked **exhaustively** rather than by eye. An app's
 * conformance test asks for `CONTRACT_COLOR_TOKENS` and asserts that it has
 * mapped every one, which is what turns "we adopted the contract" from a claim
 * into something that fails a build.
 *
 * Keeping the list here rather than parsing it back out of the stylesheet is
 * deliberate: a regex over CSS would happily "find" a token in a comment, and
 * the drift it is supposed to catch is exactly a token added to one and not the
 * other. `tests/tokens-css-agrees.test.ts` asserts the two agree, so the
 * duplication is guarded rather than hoped about.
 */

/**
 * Colour tokens, grouped by the contrast obligation each one carries.
 *
 * The grouping is not documentation — {@link assertContractConformance} reads
 * it to decide what to assert about each token, so moving a token between
 * groups changes what an app has to prove.
 */
export const CONTRACT_COLOR_TOKENS = {
  /** Backgrounds a reader's eye rests on. Nothing is asserted *about* them; they are what other tokens are asserted *against*. */
  grounds: ["--ui-ground", "--ui-ground-deep"],
  /** Raised planes. Also grounds for contrast purposes. */
  surfaces: ["--ui-surface", "--ui-surface-raised", "--ui-surface-sunk"],
  /** Body-copy ink. Must clear {@link WCAG_TEXT} against every ground and surface. */
  ink: ["--ui-ink", "--ui-ink-secondary"],
  /** Large-text, ornament and disabled ink. Clears {@link WCAG_UI} only — never body copy. */
  inkLarge: ["--ui-ink-tertiary"],
  /** Non-text UI that must be perceivable: control boundaries, the focus ring. Clears {@link WCAG_UI}. */
  ui: ["--ui-hairline-strong", "--ui-focus"],
  /** Decoration with no contrast floor. A card is told apart by its surface, not its edge. */
  decorative: ["--ui-hairline", "--ui-accent-soft"],
  /** Fills. What sits *on* them is asserted, not they themselves. */
  fills: ["--ui-accent", "--ui-accent-strong", "--ui-danger"],
  /** Ink that sits on a fill. Asserted against the fill it names, not against the page. */
  onFill: ["--ui-on-accent", "--ui-on-danger"],
  /** Accent and status colours used as ink on a ground. Clears {@link WCAG_TEXT}. */
  chromaticInk: ["--ui-accent-ink", "--ui-success", "--ui-warn"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/** Every colour token in the contract, flattened. */
export const ALL_COLOR_TOKENS: readonly string[] = Object.values(CONTRACT_COLOR_TOKENS).flat();

/** Radius, type-family and motion tokens. No contrast obligation, so they are listed separately. */
export const CONTRACT_SCALAR_TOKENS = {
  radius: [
    "--ui-radius-hair",
    "--ui-radius-sm",
    "--ui-radius-md",
    "--ui-radius-lg",
    "--ui-radius-pill",
    // A role rather than a size, like `--ui-focus`. How round a control is
    // turns out to be an app-level decision independent of how round a card
    // is — musubi's house style is pill CTAs, cire's is a sharp 4px — and a
    // shared control that picked a sized step instead gets overridden at every
    // call site in at least one app.
    "--ui-radius-control",
    // The other role radius: the TOP corners of a bottom sheet, whose own
    // bottom corners are square against the screen edge. Independent of `lg`
    // because a sheet's grip scales with the edge it is pulled from rather
    // than with a card's corner — cire wants 28px there with 10px cards.
    "--ui-radius-sheet",
  ],
  fontFamily: ["--ui-font-body", "--ui-font-display", "--ui-font-mono"],
  focus: ["--ui-focus-width", "--ui-focus-offset"],
  motion: ["--ui-dur-fast", "--ui-dur-base", "--ui-dur-slow", "--ui-ease-out", "--ui-ease-in-out"],
  elevation: ["--ui-elev-1", "--ui-elev-2"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

/**
 * The size scales, as `role → value`.
 *
 * These are the values `tokens.css` falls back to, restated here for the same
 * reason the colour list is — so a migration can be checked against data rather
 * than by reading CSS, and so `SCALE_MIGRATION` below has something to point
 * at. `tests/tokens-css-agrees.test.ts` asserts the two do not drift.
 */
export const CONTRACT_SCALES = {
  text: {
    xs: "0.7rem",
    sm: "0.8rem",
    base: "0.9rem",
    md: "1.05rem",
    lg: "1.3rem",
    xl: "1.75rem",
    "2xl": "2.5rem",
  },
  tracking: {
    tight: "-0.02em",
    normal: "0em",
    wide: "0.04em",
    wider: "0.1em",
    widest: "0.16em",
    ultra: "0.24em",
  },
  leading: {
    none: "1.1",
    tight: "1.2",
    snug: "1.4",
    normal: "1.6",
    relaxed: "1.75",
  },
  measure: {
    xs: "20rem",
    sm: "30rem",
    md: "34rem",
    lg: "40rem",
    xl: "46rem",
    "2xl": "64rem",
    "3xl": "75rem",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/**
 * Where the arbitrary values in the tree go.
 *
 * The scales above were clustered from what the monorepo actually used, so this
 * is the inverse of that clustering and the table a codemod applies. It exists
 * here rather than in a migration script because the mapping is the *decision*
 * — the script is just the thing that carries it out — and because a reviewer
 * reading a 1,500-site diff needs to be able to check the rule rather than the
 * sites.
 *
 * ## Two sets of values this must not touch
 *
 * **Computed values.** `text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))]`
 * is not a size, it is an expression whose value depends on a runtime custom
 * property. Snapping it to a step would delete a feature — cire's organisers
 * choose that heading scale.
 *
 * **Variants.** `data-[state=open]:` and `aria-[current=page]:` are selectors
 * that happen to share the bracket syntax. A codemod that treats them as
 * arbitrary values corrupts behaviour rather than appearance, which is worse
 * and much harder to spot in review.
 *
 * ## Sizes below the scale floor
 *
 * The smallest step is `0.7rem` (11.2px). Six sites sit at 8–9.5px and move up
 * by 2–3px, which is a visible change on a badge or a superscript rather than a
 * rounding difference. They are listed here for completeness but want a
 * designer's eye during the migration, not a blind substitution.
 */
export const SCALE_MIGRATION = {
  text: {
    // → xs (0.7rem). The 8–9.5px entries are the ones to look at by hand
    "8px": "xs",
    "9px": "xs",
    "9.5px": "xs",
    "10px": "xs",
    "10.5px": "xs",
    "11px": "xs",
    "11.5px": "xs",
    "0.55rem": "xs",
    "0.58rem": "xs",
    "0.6rem": "xs",
    "0.62rem": "xs",
    "0.64rem": "xs",
    "0.65rem": "xs",
    "0.66rem": "xs",
    "0.68rem": "xs",
    "0.7rem": "xs",
    "0.72rem": "xs",
    "0.74rem": "xs",
    // → sm (0.8rem)
    "12px": "sm",
    "12.5px": "sm",
    "13px": "sm",
    "13.5px": "sm",
    "0.75rem": "sm",
    "0.76rem": "sm",
    "0.78rem": "sm",
    "0.8rem": "sm",
    "0.82rem": "sm",
    "0.84rem": "sm",
    "0.85rem": "sm",
    // → base (0.9rem)
    "15.5px": "base",
    "0.86rem": "base",
    "0.875rem": "base",
    "0.88rem": "base",
    "0.9rem": "base",
    "0.92rem": "base",
    "0.95rem": "base",
    // → md (1.05rem)
    "16.5px": "md",
    "0.98rem": "md",
    "1rem": "md",
    "1.02rem": "md",
    "1.05rem": "md",
    "1.1rem": "md",
    "1.15rem": "md",
    // → lg (1.3rem)
    "22px": "lg",
    "1.2rem": "lg",
    "1.25rem": "lg",
    "1.3rem": "lg",
    "1.4rem": "lg",
    "1.5rem": "lg",
    // → xl (1.75rem)
    "26px": "xl",
    "28px": "xl",
    "1.6rem": "xl",
    "1.7rem": "xl",
    "2rem": "xl",
    // → 2xl (2.5rem)
    "34px": "2xl",
    "42px": "2xl",
    "2.5rem": "2xl",
    "2.75rem": "2xl",
    "3rem": "2xl",
    "3.25rem": "2xl",
  },
  tracking: {
    "-0.02em": "tight",
    "-0.01em": "tight",
    "0.02em": "wide",
    "0.04em": "wide",
    "0.05em": "wide",
    "0.06em": "wide",
    "0.08em": "wider",
    "0.1em": "wider",
    "0.12em": "wider",
    "0.14em": "widest",
    "0.16em": "widest",
    "0.18em": "widest",
    "0.2em": "widest",
    "0.22em": "ultra",
    "0.24em": "ultra",
    "0.25em": "ultra",
    "0.26em": "ultra",
    "0.28em": "ultra",
  },
  leading: {
    "1.05": "none",
    "1.08": "none",
    "1.1": "none",
    "1.15": "none",
    "1.2": "tight",
    "1.4": "snug",
    "1.55": "normal",
    "1.6": "normal",
    "1.65": "normal",
    "1.7": "relaxed",
    "1.75": "relaxed",
    "1.8": "relaxed",
  },
} as const satisfies Readonly<Record<string, Readonly<Record<string, string>>>>;

/** WCAG 2.2 minimum contrast for body text. */
export const WCAG_TEXT = 4.5;

/** WCAG 2.2 minimum contrast for large text and non-text UI. */
export const WCAG_UI = 3;

/**
 * The pairs {@link assertContractConformance} checks, derived from the groups
 * above rather than listed by hand.
 *
 * Every ink is measured against every ground and surface, because a token that
 * clears 4.5:1 on the page and fails it on a raised menu is a real defect and
 * the naive version of this check — ink against `--ui-ground` alone — does not
 * see it. That is nine assertions per ink token, which is why this is generated.
 */
export function contrastPairs(): readonly { fg: string; bg: string; min: number }[] {
  const grounds = [...CONTRACT_COLOR_TOKENS.grounds, ...CONTRACT_COLOR_TOKENS.surfaces];
  const pairs: { fg: string; bg: string; min: number }[] = [];

  for (const fg of CONTRACT_COLOR_TOKENS.ink) {
    for (const bg of grounds) pairs.push({ fg, bg, min: WCAG_TEXT });
  }
  for (const fg of CONTRACT_COLOR_TOKENS.chromaticInk) {
    for (const bg of grounds) pairs.push({ fg, bg, min: WCAG_TEXT });
  }
  for (const fg of [...CONTRACT_COLOR_TOKENS.inkLarge, ...CONTRACT_COLOR_TOKENS.ui]) {
    for (const bg of grounds) pairs.push({ fg, bg, min: WCAG_UI });
  }

  // On-fill ink is asserted against the fill it names, never against the page:
  // `--ui-on-accent` sitting on `--ui-ground` is a combination no component
  // produces, and asserting it would fail honest palettes for no reason.
  pairs.push({ fg: "--ui-on-accent", bg: "--ui-accent", min: WCAG_TEXT });
  pairs.push({ fg: "--ui-on-accent", bg: "--ui-accent-strong", min: WCAG_TEXT });
  pairs.push({ fg: "--ui-on-danger", bg: "--ui-danger", min: WCAG_TEXT });

  return pairs;
}
