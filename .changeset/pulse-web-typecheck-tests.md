---
"@pulse/web": patch
---

Type-check `pulse/web/tests/` and fix the 85 errors it had been hiding.

`tsconfig.json` had `"include": ["src"]`, so `tsc --noEmit` never read a line
of the test suite — matching the `osn/ui` and `osn/client` precedent, it is now
`["src/**/*", "tests/**/*"]`.

What that surfaced:

- Every event fixture was a partial literal. `EventItem` is derived from the
  Eden treaty response type and carries all 31 columns of the events table, so
  each fixture was missing about 25 fields. Replaced with one shared
  `tests/helpers/events.ts` exporting `makeEvent(overrides)` over a complete
  base, so a test names only the fields it asserts on.
- `@testing-library/jest-dom` was a declared devDep that nothing imported. The
  matchers worked at runtime but had no types, so `toHaveAttribute` was a
  `TS2339`. Added `tests/setup.ts` importing
  `@testing-library/jest-dom/vitest`, wired through `setupFiles`.
- Two files wrote `render(() => wrapRouter(factory))`. `wrapRouter` already
  returns `() => JSX.Element`, so this built `() => () => JSX.Element` and only
  worked because Solid's insert calls a function child as an accessor. The
  other eleven call sites already had it right.
- Three `vi.fn(() => X)` mocks were re-exposed through
  `(...args: unknown[]) => mock(...args)` wrappers. Under vitest 4 a bare
  `vi.fn()` accepts any args but `vi.fn(() => X)` infers a zero-parameter
  signature, so the spread was a `TS2556`. Widened each implementation to
  `(..._args: unknown[])`.
- Exported bare `vi.fn()` consts tripped `TS2883` — their inferred type cannot
  be named without referencing `Procedure` from `@vitest/spy`. Annotated as
  `Mock`.
- `createdByName: undefined` / `location: undefined` in `ExploreCard.test.tsx`:
  both fields are `string | null`, not optional.
- An `as const` onboarding fixture typed `interests` as `readonly ["music"]`,
  which is not an `InterestCategory[]`. Annotated with
  `CompleteOnboardingPayload` instead.

462 tests across 40 files still pass; `tsc --noEmit` is clean.

Closes #706.
