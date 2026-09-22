# @cire/ui

cire's own component layer: the chrome `@shared/ui` should not carry, because it is
this product's house style rather than anything a second product would want.

Seven components: `Button`, `Card`, `Loading`, `DietaryPresets`,
`DietaryPresetsPopover`, `Reveal`, and a combobox-shaped `UsernameInput`. Everything a cire surface needs that is not house style —
`Field`, `Notice`, `EmptyState`, `Chip`, `Stat`, `Meter`, `Table`, `Modal`,
`SafeProps` — is in `@shared/ui`, because none of it is cire-specific; it was
only cire-_located_.

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
The same trap catches motion: `--dur-fast` is declared in `cire/host` and
`cire/vendor` and in neither `cire/invites` nor `cire/landing`, so a component
here that spelled `duration-(--dur-fast)` would animate on two surfaces and sit
untimed on the other two.

The visible cost is that transitions here are plain Tailwind durations rather
than cire's `--dur-*` scale, so they do not follow `--motion-scale`. Nothing in
any app writes that property — it exists so a fixtures page can slow the whole
portal to 0.1× and judge a reference behaviour frame by frame — so what is lost
is a development affordance for these components, not a user-facing one.
The reduced-motion kill switch is a global rule in each app's `global.css` and
is unaffected.

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
