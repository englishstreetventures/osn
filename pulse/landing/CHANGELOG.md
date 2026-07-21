# @pulse/landing

## 0.1.1

### Patch Changes

- f951187: Astro 7 + vite 8 migration: `astro ^6.4.6 → ^7.1.1`, `@astrojs/solid-js ^6.0.1 → ^7.0.1` (all astro sites), `@astrojs/cloudflare ^13.7.0 → ^14.1.3` (guest site). Clears the three astro XSS advisories (GHSA-4g3v-8h47-v7g6, GHSA-f48w-9m4c-m7f5, GHSA-7pw4-f3q4-r2p2). Root `vite` override raised `^7.3.5 → ^8.0.13` (astro 7 requires vite 8) with workspace devDeps restored to `^8.0.13`, and the `esbuild` override floor raised `^0.25.0 → ^0.27.0`. `compressHTML: true` pinned in all astro configs to preserve Astro 6 whitespace output.

## 0.1.0

### Minor Changes

- 04b279e: Add `@pulse/landing` — the Pulse events marketing site. A new static Astro +
  SolidJS + Tailwind v4 package, same stack as `@cire/landing`, with a colourful,
  energetic identity that follows the Pulse design system (`pulse/DESIGN.md`):
  Instrument Serif / Geist / Geist Mono type, the coral/ember accent family, a
  warm-light base and a vivid multi-colour category palette.

  Signature visuals are two self-contained Solid islands: a `PulseField` backdrop
  of colourful pulsing dots / radiating rings (echoing the app's pulsing-coral-dot
  mark) and a `PulseHero` with an editorial italic-accent headline and lively
  floating chips. Both honour `prefers-reduced-motion` and render statically
  without JS.

  Sections (Promise, Features, How-it-works, the colourful Categories showcase, a
  Venues lineup teaser, FAQ, Final CTA) plus `SiteFooter` and draft privacy /
  terms pages. Copy is grounded in real Pulse features (discovery by
  location/category/friends, "today near you", effortless RSVPs, calendar + iCal
  export, venue pages, event group chats, organiser tools, hidden attendance).
  CTA target + categories live in `lib/site.ts` (`PUBLIC_APP_URL` baked at build).

  Fully static, no external images / first-party API calls, so it carries the same
  tight CSP (`_headers`) and `data-reveal` scroll-reveal primitive as
  `@cire/landing`. Dev/preview on port **4325**; root script `dev:pulse-landing`.
  See `[[wiki/apps/pulse-landing]]`.
