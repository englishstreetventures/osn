---
"@musubi/social": minor
"@pulse/web": minor
---

Give `@musubi/social` and `@pulse/web` the browser test tier neither had, and
use it to prove the token contract reaches the pixel.

Until now `test:browser` was declared in exactly two packages, both cire, so
the root `turbo test:browser` covered cire alone and the two apps that consume
`@shared/ui` had no way to see rendered CSS at all. Their fast tier computes no
styles: it can assert a component carries `base:bg-ui-accent` as a string, but
not that the class emitted any CSS, that it won the cascade, or what colour was
painted. A Tailwind utility the scanner cannot resolve emits **nothing** — no
error, no rule — and every string assertion still passes.

Each app's `vitest.config.ts` splits into `unit` and `browser` projects on the
`cire/host` model, including the `VITEST_BROWSER_EXECUTABLE_PATH` escape hatch
for environments shipping a prebuilt Chromium whose build number does not match
the pinned Playwright.

The tests check the whole chain as colour rather than as text:
`bg-ui-accent` → `--color-ui-accent` → `--ui-accent` → the app's own
`--primary`, compared against that token resolved through the browser. They
also pin the two things a stylesheet-level test cannot see — that `base:` still
compiles to `:where(…)`, so a call-site `class` beats a component default; and,
in pulse, that `--ui-accent` paints the neutral `--primary` and **not** the
coral `--pulse-accent`, so nobody can "fix" the mapping to the brand colour and
silently repaint every shared button.

One trap is documented in `wiki/conventions/browser-tests.md`: every primitive
carries `transition-colors`, so `getComputedStyle` read immediately after
toggling `.dark` returns the value part-way through the transition — at t=0,
the old colour. A theme-switching test must kill transitions first, or it fails
while the token chain underneath it is entirely correct.
