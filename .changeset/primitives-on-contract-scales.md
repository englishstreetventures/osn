---
"@shared/ui": minor
"@shared/design-tokens": minor
"@musubi/social": patch
"@pulse/web": patch
---

The primitives move onto the contract's size scales, and controls get a radius of their own

The #1045 re-key moved every primitive's **colours** onto the contract and left
its **sizes and radii** on Tailwind's defaults — 14 of 23 components still wrote
`text-sm`, `rounded-md`, `rounded-full`. That is what the apps had been
overriding: 82 component-override sites between `@musubi/social` and
`@pulse/web`, and the commonest shapes were all "your default size is not our
size". 36 utilities are now contract steps, mapped by value through
`SCALE_MIGRATION` rather than by name.

**`--ui-radius-control` is new**, and it is a role rather than a size — the
same way `--ui-focus` is its own colour rather than an alias of the accent.
How round a *control* is turns out to be an app-level decision independent of
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
