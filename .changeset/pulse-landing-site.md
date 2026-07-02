---
"@pulse/landing": minor
---

Add `@pulse/landing` — the Pulse events marketing site. A new static Astro +
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
