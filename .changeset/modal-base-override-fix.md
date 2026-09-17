---
"@cire/host": patch
"@cire/invites": patch
"@cire/landing": patch
---

Nine `Modal` call sites were being silently overruled by the component's own defaults

`Modal`'s defaults are `base:`-prefixed — `:where(…)`, zero specificity — so
that a caller's utility wins. That only holds when the caller's utility is
*plain*. A `base:` one ties, and a tie is resolved by Tailwind's stylesheet
order, which is neither the class-attribute order nor anything the call site can
see: `.base\:max-w-ui-sm` is emitted after `.base\:max-w-lg`, so the component
beat its own caller with every string assertion still passing.

The consent preferences dialog was the worst of the nine — 480px instead of
512px, and painted on `--ui-surface-raised` instead of the page ground, which
put the panel on the same colour as the category rows inside it and stopped them
reading as rows. On the one surface whose whole job is being legible.

Also affected: `ImageCropModal` (30rem instead of 42rem), the events side drawer
(30rem instead of 28rem, and it kept the square corners it asked to remove), and
four more in `cire/host`. `DemoModal` in `cire/landing` was saved by coincidence
— its `max-w-[480px]` lost to a default of exactly the same width.
