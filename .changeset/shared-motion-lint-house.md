---
"@tools/oxlint-house": minor
"@cire/envelope": patch
"@cire/invites": patch
"@cire/landing": patch
"@tools/e2e": patch
---

New rule `house/no-literal-motion`, at `error` in product `src/`: a written duration, delay or easing in a `transition` or `animation` (class strings, style objects, injected stylesheets, vendor-prefixed properties included), Tailwind's `duration-*`, `delay-*` and `ease-linear` and their arbitrary forms, Tailwind's `ease-in`, `ease-out` and `ease-in-out` wherever they read Tailwind's own curve rather than an app's theme token (everywhere but cire, and `ease-in` in cire too), and `transition-all` are reported, so a motion reads the token for its job. Its matcher, `scripts/lib/motion-literals.ts`, also runs over `.css` and `.astro` files through `scripts/check-motion-literals.ts`, which CI runs. In cire, the hero fades, the scroll cue, the closing band, the marketing site's reveal, fan and cross-fades and the envelope's prompt now scale their durations by `--motion-scale` like every other cire duration, which changes nothing on screen; the envelope's prompt fades in on cire's `--ease-out`. The RSVP fill's sweep and the envelope's cover keep their written times, each with its reason: both are timed with script. The `cire-invite-envelope` flow now checks that a phone lays out only the hero's narrow crop layer and a desk only the wide one, each fading on 0.7s.
