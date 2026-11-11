---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/ui": patch
---

Cire's `--ease-out` is now `cubic-bezier(0.23, 1, 0.32, 1)`, the strong ease-out
the motion skills name, and the one curve for something arriving in all four
apps: the host and vendor portals, the guest site and the marketing site.
Everything that already arrived on `--ease-out` — a hover, a menu, a panel, a
disclosure, the unlock reveal's rises — moves by at most 1.1% of the distance
from where it was.

Each app's stylesheet also sets Tailwind's default curve to `--ease-out`, so a
transition that names no easing runs it in place of Tailwind's
`cubic-bezier(0.4, 0, 0.2, 1)`: the shared `Checkbox`, `RadioGroupItem`,
`Switch` and `Meter`, the host's code-style and design picker cards, `Card`'s
call to action, and the guest site's hero photo fade and scroll cue exit. These start much faster than before — 68% of the way a fifth
of the way through, where Tailwind's curve had gone 13% — and end at the same
moment; the change shows most on the hero photo's 700ms fade and the scroll
cue's 500ms exit.

`Modal`'s rise and the tooltips' and popovers' entries keep the shared
contract's `--ui-ease-out`, at most 1.1% from cire's curve: the same token
times a popover's exit, and mapping it would move that exit too. `@cire/ui`'s
test stylesheet carries the same lines, and the vendor portal's token test
holds every copy to the host's.
