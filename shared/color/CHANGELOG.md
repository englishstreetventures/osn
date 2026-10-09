# @shared/color

## 0.3.2

### Patch Changes

- 4aaec17: Type-check shipped source at the guest invite site's browser floor. Each package
  states `lib` ES2022 in its own `tsconfig.json` (with DOM for `@shared/rp-auth`,
  `@shared/toast` and `@shared/ui`), and `@shared/color`, `@shared/design-tokens`
  and `@shared/legal` extend `base.json` with no ambient types instead of the Node
  preset, whose `bun-types` declare built-ins newer than the floor. An ES2023 or
  later library method, such as `toSorted`, now fails `check`. The tests of `@shared/color`, `@shared/design-tokens` and `@shared/ui`
  move to `tests/tsconfig.json`, which `check` also runs, so the shipped-source
  program loads no `@types/node`; `@shared/color` and `@shared/design-tokens` tests
  are type-checked for the first time. No runtime change.

## 0.3.1

### Patch Changes

- 7f0b645: Set package author to English Street Ventures Pty Ltd, license to UNLICENSED, and repository URL.

## 0.3.0

### Minor Changes

- 21f3cff: New `@shared/color`: the OKLCH colour maths — `parseColor`/`parseCssColor`,
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

## 0.2.0

### Minor Changes

- ac41e37: New `@shared/color`: the OKLCH colour maths — `parseColor`/`parseCssColor`,
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
