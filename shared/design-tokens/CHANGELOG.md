# @shared/design-tokens

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
