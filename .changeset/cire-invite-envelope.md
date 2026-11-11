---
"@cire/envelope": minor
"@cire/invites": minor
"@cire/host": patch
"@cire/ui": patch
"@cire/api": patch
"@tools/e2e": patch
---

A guest whose couple chose an envelope opens the invite from it. On a first
visit in a browser with HTML-in-Canvas (Chrome, on production through an
origin trial), the page waits
behind a Three.js envelope sealed with wax; a tap fires a haptic, breaks the
seal one of three ways (split, peel, crumble), and the card, drawn live from the
invite's own hero, slides out and grows until it is the hero, where the page
takes over. Further taps speed it up. A second visit goes straight to the hero,
and "Open the envelope again" above the footer plays it again. Other browsers,
reduced motion, a `?code=` link and any failure show the invite as it is.

- `@cire/envelope` gains `./boot` (the head boot script and stylesheet, the seen
  flag, the server's key), `./hero` (the card's inputs, readied while the scene
  downloads: the hero image as a `blob:` copy and the display font) and
  `./scene` (the scene, the card texture, the tap timeline and a placeholder
  wax seal behind `buildSeal`), with `three` and `web-haptics`. While the page
  is covered, everything under it is inert to the keyboard; when the cover
  goes, focus moves to the hero.
- `@cire/invites` renders the key and boot script in both design packs, loads
  the scene and the consent store only for a sealed page, waits for the
  consent answer, bounds readiness (3 s), the hero's backdrop (1.5 s) and the
  opening (6 s), and fails the build if the scene reaches `dist/server`. On a
  page with an envelope the hero image loads in anonymous CORS mode, crop
  layers included, so it is downloaded once. On every invite, a hero image
  that fails before the page hydrates now drops to the gradient instead of
  leaving a hidden image over it.
- `@cire/ui` lists the seen flag in the guest notice as strictly necessary
  storage ("Your opened envelope"), and the notice's date moves to
  2 November 2026.
- `@cire/host`: the envelope picker's note says who sees the envelope.
- `@cire/api`: the E2E seed gives the envelope wedding a hero image with both
  crops, and adds a plain-hero envelope wedding in the gala pack and a wedding
  with none.
- `@tools/e2e`: the `cire-invite-envelope` flow, and an `envelope` fixture
  option, off by default, that takes HTML-in-Canvas away from every other flow.
