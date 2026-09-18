---
"@pulse/web": patch
"@pulse/landing": patch
"@tools/lab": patch
"@shared/ui": patch
---

Final `@shadcn/lint` pass over the Pulse surfaces and the lab: `no-restyle` and
`no-arbitrary-values` both reach zero there.

**Two `shared/ui` defects the migration found by being blocked on them.**

`DropdownMenuTrigger` was a bare Kobalte re-export with no styling and no focus
treatment at all, so an avatar-as-trigger — the account menu in both the Pulse
header and the explore nav — had no focus ring a call site was allowed to give
it. It now takes a `treatment`, `bare` by default so the `as={Button}` spelling is
untouched, and `pill` for the trigger that is itself the control. The ring and
the radius are one choice because they cannot disagree: a rectangular focus ring
around a circular avatar is the defect, not a variation on it. Both call sites
render identically — Pulse maps `--ui-focus` to its own `--ring` and
`--ui-radius-pill` to `9999px`.

`DialogClose` had been given a concrete `ComponentProps<"button">`, which
dropped Kobalte's polymorphic `as` from the type while leaving it working at
runtime. Its own doc comment names `<DialogClose as={Button}>Cancel</DialogClose>`
as the pattern the `bare` treatment exists to serve, and `tools/lab` is the only
consumer of it repo-wide, so the type regression broke that package's typecheck
and nothing else. Both are polymorphic again.

Pulse's arbitrary values become named entries in each app's own theme block
rather than the library-facing contract: `@pulse/landing` gains `--text-tag`,
`--text-meta`, three `--tracking-mono-*` steps and `--leading-display`;
`@pulse/web` gains `--container-hero` and `--spacing-accent-word`. The two hero
font sizes are named rather than snapped — 9.6px and 10.4px both sit below the
scale's smallest step, so rounding them up would change the eyebrow rather than
tidy it. Verified against the built CSS, since a wrong `@theme` entry emits no
rule at all rather than an error.

`tools/lab`'s radius maps gain `--ui-radius-sheet`, which the contract had
added without them catching up.
