---
"@tools/oxlint-house": minor
"@cire/envelope": patch
"@cire/invites": patch
"@cire/landing": patch
---

New rule `house/no-literal-motion`, at `error` in product `src/`: a written duration, delay or easing in a `transition` or `animation` (class strings, style objects, injected stylesheets), Tailwind's `duration-*`, `delay-*` and `ease-linear` and their arbitrary forms, and `transition-all` are reported, so a motion reads the token for its job. Its matcher, `scripts/lib/motion-literals.ts`, also runs over `.css` and `.astro` files through `scripts/check-motion-literals.ts`, which CI runs. In cire, each literal that no token of its job replaces now states its reason (the hero fades, the RSVP fill's sweep, the envelope's cover and prompt, the marketing site's reveal, fan and cross-fades); nothing moves differently.
