---
"@cire/landing": minor
---

Replace the static floral backdrop with a generative, scroll-grown vine system,
and make the hero's sealed state a full-page envelope.

- **Generative vines** (`VineCanvas.tsx` + `lib/vines/`): vines emerge from the
  left/right page edges, meander down and inward, curl into logarithmic-spiral
  tendrils, and carry golden-angle leaves + flowers. Procedurally generated from
  a seed (seedable PRNG + Catmull-Rom→Bézier smoother, unit-tested for
  determinism); the server prerenders stable roots + a fully-drawn fallback, and
  the client regenerates a unique field per load and animates each vine "growing"
  (stroke draw-on) as it scrolls into view via a single CSS custom property.
  Reduced motion / no-JS shows the vines fully drawn.
- **Full-page envelope hero**: the whole first screen is now the front of a
  sealed envelope (full-bleed flap + body + centred wax seal) that opens to
  unveil the page, instead of a small letter card mid-screen.
