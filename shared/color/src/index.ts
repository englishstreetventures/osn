/**
 * OKLCH colour maths — parsing, conversion, WCAG contrast, and the lightness
 * moves the cire palette derivation is built from.
 *
 * This lives in `@shared/*` rather than in `@cire/theme`, where it grew up,
 * because `@shared/design-tokens`' conformance harness needs the same
 * `contrastOklch` / `parseColor` / `WCAG_*` surface to assert a token
 * mapping's contrast. A `@shared` package cannot depend on a product package,
 * so the maths moved down rather than the harness moving up.
 *
 * `@cire/theme` re-exports everything here, so its own consumers are
 * unchanged and `palette.ts` still reads these as if they were local.
 */
export * from "./color";
