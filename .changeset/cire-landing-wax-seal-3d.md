---
"@cire/landing": patch
---

Rebuild the cire marketing landing page as "The Unfolding Letter", with a real 3D
wax-seal hero.

- **3D wax seal hero.** The signature seal is now a genuine 3D object rendered
  with Three.js (`WaxSeal3D.tsx` + `waxSealScene.ts`): an embossed "C" monogram
  (canvas heightmap → bump map on a waxy `MeshPhysicalMaterial`), a warm gold key
  light against a cool forest fill, a slow idle tilt and a pointer lean. It is
  ambient (it never breaks) and settles gently on load. Three.js (~515 KB) is kept
  strictly off the critical path: a flat CSS-disc poster renders server-side, and
  the scene is `import()`ed on idle and cross-faded in. No WebGL or
  `prefers-reduced-motion` never loads it, and the poster stands in.
- **Progressive-enhancement fix.** The hero headline, subtext and both CTAs are
  now server-rendered and always visible with a proper focus ring. The previous
  `WaxSealHero` hid all hero content behind `display:none` until JS opened the
  envelope, so a JS/WebGL failure left no value prop and no CTA.
- **Anti-slop redesign** (via the hallmark + design-taste-frontend skills):
  display headings are roman, not italic; eyebrows rationed to two on the page;
  the em-dash removed from all visible copy; the five-identical-zigzag Features
  section recomposed into two lead splits plus a text index; the 3-column step
  grid became a vertical numbered sequence; a minimal sticky masthead and a
  sign-off footer added; the demo's imitation browser chrome replaced with an
  honest wax-mark frame.
- Preserved: the forest-green + gold brand tokens (byte-identical to `cire/web`),
  Cormorant + Lato, and the generative vine backdrop.

Adds `three` + `@types/three` to `@cire/landing`. Retires `WaxSealHero.tsx` and
`WaxSeal.motion.ts`.
