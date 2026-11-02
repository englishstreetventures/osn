# @shared/color

## 0.3.6

### Patch Changes

- ef3d36d: Dependency bumps within the caution window: `effect`, `@effect/platform-bun`,
  `@effect/platform-node`, `@effect/sql-d1` and `@effect/opentelemetry` 4.0.7
  (with the matching root overrides for `@effect/platform-node-shared`,
  `@effect/sql-d1` and `@effect/sql-sqlite-do`), `jose` 6.2.14, `astro` 7.4.4,
  `@astrojs/solid-js` 7.1.0, `@opentelemetry/*` 0.223.0 and 2.12.0,
  `@growthbook/growthbook` 1.8.0, `@solidjs/start` 2.0.6, `cropperjs` 2.3.1,
  `lucide-solid` 1.59.0, `motion` 13.5.1, `vitest` and the `@vitest/*` packages
  5.0.5 (which clears the moderate dev-server file-read advisory). The root
  overrides for `@opentelemetry/core` (`^2.12.0`) and `seroval` (`~1.6.11`, which
  clears two moderate serialisation advisories) rise with them. `wrangler` stays on 4.149.0, which
  `@cloudflare/vite-plugin` pins exactly. `solid-js` stays on 1.9.15 (see the cire
  changeset for why).

## 0.3.5

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.

## 0.3.4

### Patch Changes

- fa0f54a: Name the GitHub organisation `englishstreetventures` in the `repository` URL and in the comments and tests that cite a repository or issue.

  Comments and tests that pointed at an issue in the private tracker now state the constraint without the reference.

## 0.3.3

### Patch Changes

- 6b5f538: Refresh the eligible Effect libraries to 4.0.3 and align the Vitest family at
  5.0.3. Update the affected schema, tracing, and test integrations for the stable
  Effect API; refresh the eligible WebAuthn, Three.js, and Nitro consumers.

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
  (englishstreetventures/osn#1043) needs the same `contrastOklch`/`parseColor`/`WCAG_*`
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
  (englishstreetventures/osn#1043) needs the same `contrastOklch`/`parseColor`/`WCAG_*`
  surface to assert that an app's token mapping clears its contrast floors, and
  a `@shared/*` package cannot depend on a product package. The maths moved
  down rather than the harness moving up.

  `cire/theme/tests/color.test.ts` came with it and was **rewritten for
  vitest** — it ran on `bun:test` because `@cire/theme` does, and every
  `shared/*` package runs vitest.
