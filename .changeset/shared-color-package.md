---
"@shared/color": minor
---

New `@shared/color`: the OKLCH colour maths — `parseColor`/`parseCssColor`,
`oklchToRgb`/`rgbToOklch`, `contrastRatio`/`contrastOklch`, `luminance`,
`shiftLightness`/`withAlpha`/`ensureContrast`, `formatOklch` and the
`WCAG_TEXT_MIN`/`WCAG_UI_MIN` floors.

Moved wholesale from `cire/theme/src/color.ts`, which had no imports of its
own, so the lift is mechanical. It moved because `@shared/design-tokens`
(xchromo/osn#1043) needs the same `contrastOklch`/`parseColor`/`WCAG_*`
surface to assert that an app's token mapping clears its contrast floors, and
a `@shared/*` package cannot depend on a product package. The maths moved
down rather than the harness moving up.

`cire/theme/tests/color.test.ts` came with it and was **rewritten for
vitest** — it ran on `bun:test` because `@cire/theme` does, and every
`shared/*` package runs vitest.
