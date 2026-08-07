---
"@cire/host": patch
---

Rebuild the host portal's colour, type and theme foundation.

Both ramps are re-cut in OKLCH around a deep evergreen ground with `#2F4B26` as the brand fill and gold as metal. The light ramp is a warm cream a shade below white, tuned so an unintended light mode at night is not a flashbang. Colours are declared as custom properties and aliased through a non-inline `@theme`, so the invite preview's scoped `var(--color-*)` overrides keep working. Every pair with a contrast contract is asserted by `styles/tokens.test.ts`, which parses the stylesheet and composites translucent tokens over their real ground rather than measuring a duplicated table.

Fonts are now self-hosted through Astro's Fonts API — Schibsted Grotesk for the interface and Cormorant Garamond for the wordmark, wedding names and the invite preview. That removes the render-blocking `fonts.googleapis.com` round trip from every page of a signed-in dashboard.

Theme preference gains a third state. `system`, `dark` and `light` are stored separately, so opening the menu no longer silently pins a host who was following their OS. A zero-import boot script runs before first paint on both pages, and resolves to a theme even where `localStorage` throws or `matchMedia` is missing.

`cire/host/DESIGN.md` records the token contracts, the typeface decision and the motion scale.
