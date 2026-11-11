# @shared/design-tokens

## 0.6.1

### Patch Changes

- 5bc7db4: `DialogTitle` reads its weight from the design-token contract's title-weight role, `--ui-weight-title`, through the utility `font-ui-title`, as `Badge` does, and falls back to 600, the `font-semibold` it carried before. The token's comments in `tokens.css` and `index.ts` name both parts that read it. No app maps the token, so pulse's three dialogs, Musubi's and the auth views draw their titles exactly as before; a snapshot of the title's computed style written before the change still passes, and pulse's browser tests check 600 under pulse's own stylesheet. An app whose house style stops at 500 maps the token once instead of passing a class to each title.

  An app that wants its overlays to fade without scaling sets `--ui-scale-enter` and `--ui-scale-exit` to 1. Every Kobalte overlay then changes only its opacity; `Modal`'s exit scale stops too, while its rise and sink stay, and its entry keeps its own `scale(0.98)`, so it still grows as it opens. No component changed for this: the browser tests now prove it, and the design-token wiki page describes it. Default motion is unchanged.

## 0.6.0

### Minor Changes

- 2c2906f: A title weight in the token contract, and `Badge` reads it.

  - `@shared/design-tokens`: new role token `--ui-weight-title`, the weight a shared part sets a short title or a tag in, read through the utility `font-ui-title` (`--font-weight-ui-title` in `@theme inline`). It falls back to 600. `CONTRACT_SCALAR_TOKENS.fontWeight` lists it, and the agrees test fails if `tokens.css` does not alias it. The README's contract table gains it, with the `field` and `sheet` radius roles it was missing.
  - `@shared/ui`: `Badge`'s label reads `font-ui-title` in place of `font-semibold`, so an app sets its weight once with `--ui-weight-title`. No app maps it, so every badge still draws at 600. `Badge`'s props refuse `innerHTML`, `innerText` and `textContent` (`SafeProps`). `Badge` carries no focus classes: a label takes no focus, so it draws no ring and removes no outline. A frozen snapshot of the unmapped badge's computed style, written before the change, holds pulse's look.
  - `@tools/lab`: `Badges` shows both treatments and gains a treatment control; new `BadgeWeights` shows every badge unmapped and under `--ui-weight-title: 500`, captioned with the computed weight. The theming story's unmapped column also clears the weight token.
  - `@pulse/web`: the token-contract browser test checks pulse's three badges compute 600 under its own stylesheet.

## 0.5.0

### Minor Changes

- e71aee5: Errors read as plain sentences, in the place they are about.

  - `@osn/auth-ui`: every view shows a sentence from `describeAuthError` or `describePasskeyError`, never an error's own text, in an inline danger `Notice` with `role="alert"` — under the field it is about (tied by `aria-describedby`, `aria-invalid` only when the input was refused) or above the action it follows. No error toasts. `SignIn`'s passkey error carries "Lost your passkey?"; `Register`'s age hint reads "You must be 13 or older to create an account."; `TurnstileWidget` says "Reload and try again". A failed passkey, authenticator or session list says it didn't load, with Try again, instead of throwing. Every call that spends a Turnstile token asks for a fresh one when it is refused. `Register` drops a spent token with its widget instead of running a challenge nobody uses, and its code step mounts a widget of its own for "Resend code" once the countdown ends. `ChangeEmailForm` and `StepUpDialog` group each field under a `Label`, and their raw inputs turn red when refused. `InlineAction` draws Button's focus ring. `SecurityEventsBanner`'s error line sits above its box, on the page.
  - `@osn/client`: `useAuth()` gains `profilesError` and `refetchProfiles`. A profile list that fails keeps the last list instead of throwing on read; when no session exists any longer, however it went, the list and its error go, and one that settles after that is dropped. Adopting a first session lists the profiles once, not twice; adopting one over another drops the old account's list first. The provider treats a session that failed to load as none, so reading it throws nowhere inside the provider.
  - `@musubi/social`: the shell says "You've been signed out." with Sign in when the session ends, and "Your profiles didn't load." with Try again when the list fails. A page that throws while rendering shows "This page didn't load." with Try again inside the shell instead of blanking the app. `/authorize` reads its failures from the copy map. Every failed-load and error line, on `/authorize`, Connected apps and an organisation's page included, is a danger `Notice`, apart from the shell frame's own load-failure line. Connected apps' revoke and an organisation's save, delete and member removal name what failed, then the copy map's sentence. The signed-out notice's Sign in opens the shell's sign-in dialog once its chunk has loaded.
  - `@shared/design-tokens`: `checkContractConformance` takes an optional `pairs` list to measure in place of the contract's own.

## 0.4.0

### Minor Changes

- d3fe597: Overlays leave faster and smaller than they arrive, and each motion token says what it is for. `tokens.css` adds `--ui-dur-exit` (80ms), `--ui-scale-enter` (0.96), `--ui-scale-exit` (0.98), `--ui-distance-enter` (24px) and `--ui-distance-exit` (8px), each with a one-line job comment, and `CONTRACT_SCALAR_TOKENS.motion` lists them. `animate-out` runs `--ui-dur-exit`; `zoom-in` and `zoom-out` replace `zoom-in-95` and `zoom-out-95` and read the scale tokens. Under `prefers-reduced-motion: reduce`, `animate-in` and `animate-out` run nothing: the old reduced-motion rule matched no overlay, so `Dialog`, `Popover` and the default `DropdownMenu` still moved.

  In `@shared/ui`, `Dialog`, `Popover` and both `DropdownMenu` looks take their scale from the tokens; `Popover`, `Tooltip` and the default menu grow from their trigger. `Tooltip` opens after 400ms, goes at once with no exit (the pointer can still cross onto it), and a neighbour opened within 300ms of another closing carries `data-instant` and does not animate. `Modal` exits in 150ms by default (was 200ms), sinking 8px to 0.98 rather than 24px, and its backdrop fades out with it. Musubi's `DESIGN.md` names the shared overlay motion; the lab's motion story reads the new duration.

## 0.3.9

### Patch Changes

- 94a7824: The token contract gains a `field` radius role for text inputs: `rounded-ui-field`, mapped through `--ui-radius-field`. `Input`, `Textarea` and `Select` take their corner from it rather than from `control`, so an app can give its buttons pill ends without making its fields pills. It falls back to `--ui-radius-control`, then `--ui-radius-md`, so an app that maps no field radius renders as before.

## 0.3.8

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
- Updated dependencies [ef3d36d]
  - @shared/color@0.3.6

## 0.3.7

### Patch Changes

- 355b956: Type-check with Bun's built-in checker. Each package's `check` script is now `typecheck` and runs `bun check` in place of `tsc --noEmit`, with the test tsconfigs checked the same way. Packages that still need `astro check` keep it. No source changes.
- Updated dependencies [355b956]
  - @shared/color@0.3.5

## 0.3.6

### Patch Changes

- fa0f54a: Name the GitHub organisation `englishstreetventures` in the `repository` URL and in the comments and tests that cite a repository or issue.

  Comments and tests that pointed at an issue in the private tracker now state the constraint without the reference.

- Updated dependencies [fa0f54a]
  - @shared/color@0.3.4

## 0.3.5

### Patch Changes

- 6b5f538: Refresh the eligible Effect libraries to 4.0.3 and align the Vitest family at
  5.0.3. Update the affected schema, tracing, and test integrations for the stable
  Effect API; refresh the eligible WebAuthn, Three.js, and Nitro consumers.
- Updated dependencies [6b5f538]
  - @shared/color@0.3.3

## 0.3.4

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
- Updated dependencies [4aaec17]
  - @shared/color@0.3.2

## 0.3.3

### Patch Changes

- 7f0b645: Set package author to English Street Ventures Pty Ltd, license to UNLICENSED, and repository URL.
- Updated dependencies [7f0b645]
  - @shared/color@0.3.1

## 0.3.2

### Patch Changes

- b229bf5: Name the GitHub organisation as `englishstventures` wherever a comment or
  test cites a repository or issue, in place of the old `xchromo` owner.
  Comments and test strings only; no behaviour changes.

## 0.3.1

### Patch Changes

- 76aa4f6: Point code comments at the wiki's new layout. The wiki now has one folder per
  product (`osn/`, `musubi/`, `pulse/`, `cire/`, `zap/`) and `shared/` for what
  applies to all of them, so references such as `wiki/systems/rate-limiting.md`
  now read `wiki/shared/rate-limiting.md`. Comments only; no behaviour changes.

## 0.3.0

### Minor Changes

- 21f3cff: Add the four size scales and the migration table that carries the tree onto
  them.

  **Type — 7 steps** (`xs` 0.7 · `sm` 0.8 · `base` 0.9 · `md` 1.05 · `lg` 1.3 ·
  `xl` 1.75 · `2xl` 2.5rem), clustered from 956 sites carrying **93 distinct
  font sizes**, nine of them between 0.7rem and 0.95rem. Seven and not eleven
  because a scale nobody can hold in their head is another way of having no
  scale. 749 of 853 mappable sites move by a pixel or less.

  **Tracking** 6 steps from 18 values (nothing moves more than 0.04em),
  **leading** 5 from 12 (nothing more than 0.05), **measure** 7 content widths,
  one unit — `max-w-[640px]` and `max-w-[40rem]` were the same number written
  twice.

  `SCALE_MIGRATION` is derived, not hand-written: every value goes to its nearest
  step, an exact tie resolving up. The test re-derives it and fails if the table
  and the rule disagree, which caught two hand-entered errors (`16.5px` and
  `0.98rem` were both filed a step too low).

  Documented exclusions the codemod must respect: computed values
  (`calc`/`clamp`/`var` — cire's organiser-chosen heading scale is one),
  `data-[…]`/`aria-[…]` variants that merely share the bracket syntax, and
  one-off layout constants, which are not measures. Six sites at 8–9.5px sit
  below the smallest step and move 2–3px; those want a designer rather than a
  substitution.

- 21f3cff: The primitives move onto the contract's size scales, and controls get a radius of their own

  The #1045 re-key moved every primitive's **colours** onto the contract and left
  its **sizes and radii** on Tailwind's defaults — 14 of 23 components still wrote
  `text-sm`, `rounded-md`, `rounded-full`. That is what the apps had been
  overriding: 82 component-override sites between `@musubi/social` and
  `@pulse/web`, and the commonest shapes were all "your default size is not our
  size". 36 utilities are now contract steps, mapped by value through
  `SCALE_MIGRATION` rather than by name.

  **`--ui-radius-control` is new**, and it is a role rather than a size — the
  same way `--ui-focus` is its own colour rather than an alias of the accent.
  How round a _control_ is turns out to be an app-level decision independent of
  how round a card is: musubi's house style is pill CTAs, cire's is a sharp 4px,
  pulse sits between. A shared control picking one of the sized steps gets
  overridden at every call site in at least one app, which is exactly what
  `<Button class="rounded-pill">` ×18 in musubi was. Those 18 are deleted.

  **`@pulse/web` had no type scale mapped at all.** It maps colours and radii, so
  every `text-ui-*` in a shared component was resolving to the contract package's
  neutral fallback — a different type system showing through in the middle of that
  one, and invisible, because a fallback renders legibly. Its seven steps are now
  written down, taken from `pulse/DESIGN.md` and from what the tree actually uses,
  and they land within half a pixel of the contract's own steps. Two tests hold
  them: all seven present, and the list ascending.

  `leading-none` stays Tailwind's in four single-line labels. The contract's
  `none` is 1.1 — a tight line, not literally none — so the two mean different
  things, and the contract now says so where the step is declared.

- 21f3cff: Adopt `@shadcn/lint`'s `no-unknown-classes` at `error`, and fix the dead
  animation classes it found.

  `Dialog`, `DropdownMenu` and `Popover` spelled their transitions the way
  shadcn/ui does — `data-[expanded]:animate-in`, `fade-out-0`, `zoom-in-95`. Those
  class names come from the `tailwindcss-animate` plugin, which this repository
  has never installed, and no stylesheet here defines them. **The three overlays
  did not animate at all**, in four apps, and nothing could see it: every gate
  reads class strings or types, and a class that generates no CSS is invisible to
  both.

  The utilities are now defined in `@shared/design-tokens`, built on the motion
  tokens already there, so there is one mechanism and no dependency to install.
  `Modal` is unaffected — it is the platform `<dialog>` and animates through
  `@starting-style`.

  `DialogContent` also carried `slide-out-to-left-1/2` and
  `slide-in-from-top-[48%]`, a Tailwind v3-era workaround for `transform`
  clobbering the centring translate during an animation. v4 compiles
  `translate-x-*` to the standalone `translate` property, so the keyframes cannot
  clobber it and the four utilities are deleted rather than reimplemented.

  _Verified 2026-09-17 — `@tailwindcss/cli` on `translate-x-[-50%]` emits
  `--tw-translate-x: -50%; translate: var(--tw-translate-x) var(--tw-translate-y)`._

  The rule needs two pieces of configuration to be honest, and both are in
  `oxlintrc.json` with the reason beside them. An `allow` list covers plain CSS
  class names (`cal-*`, `onb-*`, `ui-toast*`, …) that a stylesheet defines and a
  Tailwind build cannot know about. An override turns the rule off in `cire/ui`,
  `osn/auth-ui`, `shared/toast` and `shared/sortable` — the plugin finds a
  package's theme by walking up to a stylesheet that imports tailwindcss, those
  four have none, and without one it reports real contract utilities like
  `tracking-ui-wider` as unknown. `shared/ui` and `tools/lab` are deliberately not
  in that list: each carries a stylesheet the plugin can find, so the theme
  resolves and the rule tells the truth there.

- 21f3cff: New `@shared/design-tokens`: the token contract every shared component reads,
  and the conformance harness that makes it a contract rather than a naming
  convention.

  `tokens.css` declares the `--ui-*` names as `@theme inline` aliases with
  inline fallbacks, plus the `@source` and `@custom-variant base` directives
  consumers would otherwise each have to remember. `inline` is what lets a
  subtree redefine a token and have shared components follow it — a theme story
  showing both themes at once, or cire's invite preview rendering a wedding's
  palette inside the organiser's chrome. There is deliberately no `:root` block:
  a package-level one is unlayered, lands at the import site, and would beat an
  app mapping written inside `@layer base`.

  `conformance.ts` is a rewrite of `cire/host/tests/styles/tokens.test.ts`, not
  a move. That harness finds tokens by regex over literal `--name: oklch(…)`
  declarations, which a contract mapping never is — it is `--ui-ink:
  var(--text)`, two or three hops from a literal. Against a mapping the old
  approach matches nothing and asserts about an empty set, so the substance
  here is a `var()` resolver that follows the chain across theme scopes, plus
  cycle detection. Alpha is composited over the ground before measuring, in
  sRGB, because half the ink tokens in this monorepo are translucent and a
  naive ratio overstates every one.

  Contrast obligations are derived from the token grouping rather than listed
  by hand: every body ink is measured against all five grounds and surfaces
  (ink that clears 4.5:1 on the page and fails it on a raised menu is a real
  defect the one-ground version cannot see), decorative tokens are held to no
  floor, and on-fill ink is measured against its fill rather than the page.

  28 tests, 14 of which assert the harness produces a failure — a contrast
  guard that only ever goes green is indistinguishable from one that measures
  nothing.

  Colour half only. The type, tracking, leading and measure scales are a
  separate decision and land next.

- 21f3cff: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--ui-surface` becomes `--ui-surface`,
  `bg-ui-ground` becomes `bg-ui-ground`, `.ui-toast` becomes `.ui-toast`, and
  `--ui-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

### Patch Changes

- 21f3cff: Make the design system explorable in the lab.

  A new `design-system/` story group under `tools/lab/src/stories/`, five files,
  fourteen stories: the colour roles, the type/tracking/leading/measure scales,
  radius, elevation, the focus ring, motion, and the theming demonstration.

  Two things separate these from a token table rendered in HTML.

  **They measure what the browser painted, not what the stylesheet claims.**
  `measure.ts` reads computed style and re-reads it on a `MutationObserver` for
  `<html>`'s `class` — so the numbers beside every swatch are the current theme's
  real values, and the contrast story puts a live ratio and a pass/fail beside all
  43 pairs `contrastPairs()` generates. The conformance harness reads the
  stylesheet and cannot see a token an app set at runtime, a subtree that
  redefined one, or which theme the toggle is on. This can. It shows musubi's two
  waived pairs failing in red, because a waiver suppresses an assertion rather
  than the defect.

  **The theming story renders the same components under three mappings at once** —
  musubi's, cire's, and every token set to `initial` so the package fallbacks show
  — side by side, with only the musubi column following the light·dark toggle.
  That is the whole claim `@theme inline` makes: `bg-ui-surface` resolves at the
  element, so a subtree that redefines a token is followed. It is the property the
  contract rests on and the one thing no static table can show.

  Groups and membership are derived from `CONTRACT_COLOR_TOKENS` and
  `CONTRACT_SCALES` rather than typed out, so a token added to the contract lands
  in a group — or in a visible `unsorted` row, never silently nowhere.

  Also corrects the last of the `--osn-*` → `--ui-*` rename: the glob form
  `--osn-*`, which the suffix allowlist could not match, survived in twelve prose
  sites including `tokens.css`'s own integration example.

- 21f3cff: Give the shared primitives variants for the treatments call sites were spelling out by hand.

  `Modal` and `DialogContent` take a `presentation`, so a bottom sheet is one
  choice rather than an anchor, a radius, a pair of squared corners and a
  safe-area inset that five call sites across three products had each spelled out
  differently. The sheet's top radius reads a new `--ui-radius-sheet` token, which
  defaults to `--ui-radius-lg` so an app can make that grip pronounced without
  touching its cards.

  Also: `Badge` gains an `eyebrow` treatment, `Label` a `tone` and `size`,
  `Avatar` a `ring` for overlapping stacks, `Card` a `variant`/`elevation`/`radius`,
  `PopoverContent` a `padding`, `DialogClose` a `glyph` treatment,
  `DropdownMenuLabel` an `identity` tone, `TabsTrigger` a `size`, `Td` `code` and
  `indent`, and `Input` a `face` for identifier fields.

- Updated dependencies [21f3cff]
  - @shared/color@0.3.0

## 0.2.0

### Minor Changes

- ac41e37: Add the four size scales and the migration table that carries the tree onto
  them.

  **Type — 7 steps** (`xs` 0.7 · `sm` 0.8 · `base` 0.9 · `md` 1.05 · `lg` 1.3 ·
  `xl` 1.75 · `2xl` 2.5rem), clustered from 956 sites carrying **93 distinct
  font sizes**, nine of them between 0.7rem and 0.95rem. Seven and not eleven
  because a scale nobody can hold in their head is another way of having no
  scale. 749 of 853 mappable sites move by a pixel or less.

  **Tracking** 6 steps from 18 values (nothing moves more than 0.04em),
  **leading** 5 from 12 (nothing more than 0.05), **measure** 7 content widths,
  one unit — `max-w-[640px]` and `max-w-[40rem]` were the same number written
  twice.

  `SCALE_MIGRATION` is derived, not hand-written: every value goes to its nearest
  step, an exact tie resolving up. The test re-derives it and fails if the table
  and the rule disagree, which caught two hand-entered errors (`16.5px` and
  `0.98rem` were both filed a step too low).

  Documented exclusions the codemod must respect: computed values
  (`calc`/`clamp`/`var` — cire's organiser-chosen heading scale is one),
  `data-[…]`/`aria-[…]` variants that merely share the bracket syntax, and
  one-off layout constants, which are not measures. Six sites at 8–9.5px sit
  below the smallest step and move 2–3px; those want a designer rather than a
  substitution.

- ac41e37: The primitives move onto the contract's size scales, and controls get a radius of their own

  The #1045 re-key moved every primitive's **colours** onto the contract and left
  its **sizes and radii** on Tailwind's defaults — 14 of 23 components still wrote
  `text-sm`, `rounded-md`, `rounded-full`. That is what the apps had been
  overriding: 82 component-override sites between `@musubi/social` and
  `@pulse/web`, and the commonest shapes were all "your default size is not our
  size". 36 utilities are now contract steps, mapped by value through
  `SCALE_MIGRATION` rather than by name.

  **`--ui-radius-control` is new**, and it is a role rather than a size — the
  same way `--ui-focus` is its own colour rather than an alias of the accent.
  How round a _control_ is turns out to be an app-level decision independent of
  how round a card is: musubi's house style is pill CTAs, cire's is a sharp 4px,
  pulse sits between. A shared control picking one of the sized steps gets
  overridden at every call site in at least one app, which is exactly what
  `<Button class="rounded-pill">` ×18 in musubi was. Those 18 are deleted.

  **`@pulse/web` had no type scale mapped at all.** It maps colours and radii, so
  every `text-ui-*` in a shared component was resolving to the contract package's
  neutral fallback — a different type system showing through in the middle of that
  one, and invisible, because a fallback renders legibly. Its seven steps are now
  written down, taken from `pulse/DESIGN.md` and from what the tree actually uses,
  and they land within half a pixel of the contract's own steps. Two tests hold
  them: all seven present, and the list ascending.

  `leading-none` stays Tailwind's in four single-line labels. The contract's
  `none` is 1.1 — a tight line, not literally none — so the two mean different
  things, and the contract now says so where the step is declared.

- ac41e37: New `@shared/design-tokens`: the token contract every shared component reads,
  and the conformance harness that makes it a contract rather than a naming
  convention.

  `tokens.css` declares the `--ui-*` names as `@theme inline` aliases with
  inline fallbacks, plus the `@source` and `@custom-variant base` directives
  consumers would otherwise each have to remember. `inline` is what lets a
  subtree redefine a token and have shared components follow it — a theme story
  showing both themes at once, or cire's invite preview rendering a wedding's
  palette inside the organiser's chrome. There is deliberately no `:root` block:
  a package-level one is unlayered, lands at the import site, and would beat an
  app mapping written inside `@layer base`.

  `conformance.ts` is a rewrite of `cire/host/tests/styles/tokens.test.ts`, not
  a move. That harness finds tokens by regex over literal `--name: oklch(…)`
  declarations, which a contract mapping never is — it is `--ui-ink:
  var(--text)`, two or three hops from a literal. Against a mapping the old
  approach matches nothing and asserts about an empty set, so the substance
  here is a `var()` resolver that follows the chain across theme scopes, plus
  cycle detection. Alpha is composited over the ground before measuring, in
  sRGB, because half the ink tokens in this monorepo are translucent and a
  naive ratio overstates every one.

  Contrast obligations are derived from the token grouping rather than listed
  by hand: every body ink is measured against all five grounds and surfaces
  (ink that clears 4.5:1 on the page and fails it on a raised menu is a real
  defect the one-ground version cannot see), decorative tokens are held to no
  floor, and on-fill ink is measured against its fill rather than the page.

  28 tests, 14 of which assert the harness produces a failure — a contrast
  guard that only ever goes green is indistinguishable from one that measures
  nothing.

  Colour half only. The type, tracking, leading and measure scales are a
  separate decision and land next.

- ac41e37: Split `@osn/ui` into `@shared/ui` and `@osn/auth-ui`, and re-key the design-token
  contract from `--osn-*` to `--ui-*`.

  `wiki/architecture/osn-and-musubi.md` states the discriminator: if an independent
  implementation must use the same string to interoperate, it is OSN; otherwise it
  is not. A `Button` fails that test — nobody has to spell it the way we do — so
  the primitives were never OSN's, and the old page carved them out by hand
  ("it keeps its name because `@pulse/web` and `tools/lab` consume it as well")
  rather than applying the rule. The carve-out is gone.

  | Was                                 | Is                                        | Holds                                                                   |
  | ----------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------- |
  | `@osn/ui/ui/*`, `@osn/ui/lib/utils` | `@shared/ui/ui/*`, `@shared/ui/lib/utils` | The primitives: `Button`, `Card`, `Modal`, `Field`, `Table`, `cn()`     |
  | `@osn/ui/auth`, `@osn/ui/auth/*`    | `@osn/auth-ui`, `@osn/auth-ui/*`          | The auth views: `SignIn`, `Register`, `PasskeysView`, `StepUpDialog`, … |

  `@osn/auth-ui` stays under `osn/` because every view in it is the client half of
  a named ceremony in the spec — its shape is fixed by the protocol, not by our
  styling — and it now depends on `@shared/ui` like any other consumer. Its
  subpaths flatten (`@osn/ui/auth/SignIn` → `@osn/auth-ui/SignIn`), and the
  package's bare specifier is the barrel that `@osn/ui/auth` used to be.

  The token prefix moves with it. `--osn-surface` becomes `--ui-surface`,
  `bg-osn-ground` becomes `bg-ui-ground`, `.osn-toast` becomes `.ui-toast`, and
  `--osn-modal-enter` becomes `--ui-modal-enter`. A prefix naming the system a
  component is _not_ part of was the last thing asserting the old shape. Apps map
  the new names in exactly one place each, the contract block in their global
  stylesheet.

  The rename was driven by an explicit allowlist of the contract's own token
  suffixes rather than a blanket `osn-` → `ui-` substitution, because the same
  compound shape carries protocol identifiers that must not move: `osn-access`,
  `osn-step-up`, `osn-kid`, `osn-pairwise-salt`, the `osn-api`/`osn-social`
  Cloudflare project names. A missed token fails safe by staying `osn-`; a
  mangled audience string would not.

  One string is deliberately left spelled the old way: `ProfileOnboarding`'s
  `localStorage` key. Every browser that has already dismissed that prompt holds
  it under `@osn/ui:profile_onboarding_dismissed`, and renaming the key would show
  the prompt again to exactly the people who said no.

### Patch Changes

- ac41e37: Make the design system explorable in the lab.

  A new `design-system/` story group under `tools/lab/src/stories/`, five files,
  fourteen stories: the colour roles, the type/tracking/leading/measure scales,
  radius, elevation, the focus ring, motion, and the theming demonstration.

  Two things separate these from a token table rendered in HTML.

  **They measure what the browser painted, not what the stylesheet claims.**
  `measure.ts` reads computed style and re-reads it on a `MutationObserver` for
  `<html>`'s `class` — so the numbers beside every swatch are the current theme's
  real values, and the contrast story puts a live ratio and a pass/fail beside all
  43 pairs `contrastPairs()` generates. The conformance harness reads the
  stylesheet and cannot see a token an app set at runtime, a subtree that
  redefined one, or which theme the toggle is on. This can. It shows musubi's two
  waived pairs failing in red, because a waiver suppresses an assertion rather
  than the defect.

  **The theming story renders the same components under three mappings at once** —
  musubi's, cire's, and every token set to `initial` so the package fallbacks show
  — side by side, with only the musubi column following the light·dark toggle.
  That is the whole claim `@theme inline` makes: `bg-ui-surface` resolves at the
  element, so a subtree that redefines a token is followed. It is the property the
  contract rests on and the one thing no static table can show.

  Groups and membership are derived from `CONTRACT_COLOR_TOKENS` and
  `CONTRACT_SCALES` rather than typed out, so a token added to the contract lands
  in a group — or in a visible `unsorted` row, never silently nowhere.

  Also corrects the last of the `--osn-*` → `--ui-*` rename: the glob form
  `--osn-*`, which the suffix allowlist could not match, survived in twelve prose
  sites including `tokens.css`'s own integration example.

- Updated dependencies [ac41e37]
  - @shared/color@0.2.0
