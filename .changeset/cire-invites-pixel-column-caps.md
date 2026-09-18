---
"@cire/invites": patch
---

Restore the guest site's column caps to real pixels.

`@cire/invites` steps its root font-size 16px → 17px at 1024px, and it is the
only app in the repo that does. The `@shadcn/lint` migration converted 22
`max-w-[Npx]` caps onto Tailwind's spacing scale — `max-w-[640px]` →
`max-w-160` — which is exact at a 16px root and **6.25% wider on every desktop
viewport**, because the scale is rem. The classic pack's events column went
640px → 680px, gala's 960px → 1020px, and so on.

They read a named `--container-column-*` scale now, declared in the app's own
`@theme` in px, with the reason on the block: these caps bound a column against
the viewport, so they must not track the type step. A measure that *should*
track it belongs on the contract's `max-w-ui-*`, which is what the gift-registry
columns already use — the `34rem` sites were converted to those and are
untouched here.

Found by `EventCard.actions.browser.test.tsx`, whose wrapped case measures the
card past the 1024px step: at 680px the row stopped wrapping and the test said
so by name. Its harness carried the same swap, so it had been widened to match
and no longer measured the real cap.

`AnimatedModal` takes its 480px cap as an inline `max-width` rather than a
class. `shadcn/no-restyle` classifies a call-site class with its own grammar,
which models `max-w-*` only on Tailwind's built-in steps and rejects
`max-w-column-md` outright — even though the plugin can see the class and
`no-unknown-classes` is silent on it. Every built-in step is rem, so there is no
class form of a pixel cap available on a library component.
