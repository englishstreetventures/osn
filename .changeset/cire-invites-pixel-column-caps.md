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
the viewport, so they must not track the type step. A measure that _should_
track it belongs on the contract's `max-w-ui-*`, which is what the gift-registry
columns already use — the `34rem` sites were converted to those and are
untouched here.

Found by `EventCard.actions.browser.test.tsx`, whose wrapped case measures the
card past the 1024px step: at 680px the row stopped wrapping and the test said
so by name. Its harness carried the same swap, so it had been widened to match
and no longer measured the real cap.

`AnimatedModal` takes its 480px cap as `max-w-column-md`, like every other site.
Reaching it needs one line of linter configuration: `shadcn/no-restyle`
classifies a call-site class with `cn`'s grammar, which models `max-w-*` only on
Tailwind's built-in steps, so a `max-w-*` from any custom `--container-*` entry —
the contract's own `max-w-ui-*` included — is unclassified and the `layout`
bucket cannot reach it. Naming the two families on the contract that covers
`Modal` does, because the allow list is read after classification.
