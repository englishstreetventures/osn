---
"@cire/envelope": minor
"@cire/invites": minor
"@cire/host": patch
"@cire/ui": patch
"@cire/api": patch
"@tools/e2e": patch
---

A guest whose couple chose an envelope opens the invite from it. On a first
visit in a browser with HTML-in-Canvas (Chrome 157 and later), the page waits
behind a Three.js envelope sealed with wax; a tap fires a haptic, breaks the
seal one of three ways (split, peel, crumble), and the card, drawn live from the
invite's own hero, slides out and grows until it is the hero, where the page
takes over. Further taps speed it up. A second visit goes straight to the hero,
and "Open the envelope again" above the footer plays it again. Other browsers,
reduced motion, a `?code=` link and any failure show the invite as it is.

- `@cire/envelope` gains `./boot` (the head boot script and stylesheet, the seen
  flag, the server's key) and `./scene` (the scene, the card texture, the tap
  timeline and a placeholder wax seal behind `buildSeal`), with `three` and
  `web-haptics`.
- `@cire/invites` renders the key and boot script in both design packs, loads
  the scene only for a sealed page, waits for the consent answer, bounds
  readiness (3 s) and the opening (6 s), and fails the build if the scene
  reaches `dist/server`.
- `@cire/ui` lists the seen flag in the guest notice as strictly necessary
  storage ("Your opened envelope").
- `@cire/host`: the envelope picker's note says who sees the envelope.
- `@cire/api`: the E2E seed gives the envelope wedding a hero image with both
  crops, and adds a plain-hero envelope wedding and a wedding with none.
- `@tools/e2e`: the `cire-invite-envelope` flow, and an `envelope` fixture
  option, off by default, that takes HTML-in-Canvas away from every other flow.
