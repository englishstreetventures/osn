---
"@shared/design-tokens": minor
"@shared/ui": patch
---

Adopt `@shadcn/lint`'s `no-unknown-classes` at `error`, and fix the dead
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

*Verified 2026-09-17 — `@tailwindcss/cli` on `translate-x-[-50%]` emits
`--tw-translate-x: -50%; translate: var(--tw-translate-x) var(--tw-translate-y)`.*

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
