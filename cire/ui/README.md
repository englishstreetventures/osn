# @cire/ui

cire's own component layer: the chrome `@shared/ui` should not carry, because it is
this product's house style rather than anything a second product would want.

Eighteen components: `Button`, `Card`, `Disclosure`, `Eyebrow`, `FileInput`, `Loading`, `MessageThread`, `Note`, `PersonAvatar`,
`SegmentedTabs`, `SignInPanel`, `Skeleton`, `SkeletonOutline`, `Wordmark`, `DietaryPresets`, `DietaryPresetsPopover`, `Reveal`, and a combobox-shaped `UsernameInput`. Everything a cire surface needs that is not house style —
`Field`, `Notice`, `EmptyState`, `Chip`, `Stat`, `Meter`, `Table`, `Modal`,
`SafeProps` — is in `@shared/ui`, because none of it is cire-specific; it was
only cire-_located_.

It also holds content two cire sites publish word for word, which belongs to
neither app: the guest privacy notice (`src/guest-privacy-notice.astro`), which
the guest site renders as its `/privacy` page and cireweddings.com as
`/privacy/guests`, and the consent vendor registry the notice's cookie list is built
from (`src/consent-categories.ts`, `src/consent-vendors.ts`). The notice is one
of four Astro components here, with the portals' sign-in page (`src/sign-in-card.astro`,
which holds `SignInPanel` as an island), and the two guest-facing sites' footer
(`src/site-footer.astro`) and legal pages' document (`src/legal-layout.astro`);
each app's Astro build compiles them. The notice's and the sign-in page's tests read
their source (`tests/guest-privacy-notice.test.ts`, `tests/sign-in-card.test.ts`);
the footer's and the layout's render them with Astro's container API, in the
`astro` test project (`vitest.astro.config.ts`, `tests/*.astro.test.ts`). Any
change under `src/` redeploys all four cire frontends.

`src/lib/` holds the helpers both portals use and neither renders:
`createAutoSize` (a box animated between two content heights),
`createPreferences` and `themeBootScript` (the theme and haptics switch, and
the inline script that sets the theme before first paint, under each portal's
own storage keys), and `createHaptics` (touch feedback by event name). The
guest and marketing sites import none of them.

`UsernameInput` is the one apparent duplicate, and the reason is the API rather
than the styling: `@shared/ui`'s is controlled and renders its own debounced
availability status, this one spreads raw input props because its single call
site (`cire/host`'s add-host combobox) drives `aria-expanded`,
`aria-activedescendant` and a suggestion list onto the box. The full argument is
in `src/username-input.tsx`.

## It is written against the token contract

Every class here is a `ui-*` utility, `base:`-prefixed. **"House-specific"
describes which components live here, not a separate vocabulary** — a library
that wrote `bg-gold` would be a library that only renders in the two apps that
happen to declare `--gold`, which is exactly the bug this package exists to fix.
The same trap catches motion, so a duration here names its fallback:
`duration-(--dur-fast,100ms)` takes the app's own `--dur-*` step, which all four
cire apps declare and which follows their `--motion-scale` and pointer ladder,
and the fallback only where no app declares one, as in the component lab. A
bare `duration-(--dur-fast)` would sit untimed wherever the token is missing.
The loaders' pulse (`src/lib/pulse.ts`, shared by `Loading` and `Skeleton`,
and written out again on `SkeletonOutline`'s bars, blocks and glyphs) is
the same: 2s scaled by the app's `--motion-scale`, on its `--ease-in-out`,
never Tailwind's fixed `animate-pulse`. The curve is the app's own, which all
four cire apps declare: Tailwind's theme supplies an `--ease-in-out` of its
own (a different curve) wherever an app declares none, so the contract's
`--ui-ease-in-out` written behind it is never reached in a Tailwind app.
The reduced-motion kill switch is a global rule in each app's `global.css`. It
selects `*`, which reaches no pseudo-element, so a part that animates one —
`Disclosure`'s fade on `::details-content` — carries its own `motion-safe:`
gate.

## Adding an app

An app needs two things, both of which it almost certainly already has:

```css
@import "tailwindcss";
@import "@shared/design-tokens/tokens.css"; /* ships the `base:` variant */
@source "../../../ui/src"; /* relative to the app's global.css */
```

and the `--ui-*` mapping block. The `@source` line goes in the **app's own**
stylesheet, never in `@shared/design-tokens`: a shared file pointing at a
product package inverts the layering and would scan cire's classes into every
musubi, pulse, lab and metrics build.

## No version field

Deliberate, and load-bearing. `scripts/validate-changesets.sh` decides whether a
package is "ignored" by `has("version") | not`, and every other `@cire/*`
package is version-less. A manifest copied from a versioned template would make
this the one versioned `@cire/*` package, and any changeset naming it alongside
its siblings would then be the forbidden versioned/version-less mix.
