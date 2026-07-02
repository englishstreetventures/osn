---
"@osn/landing": minor
---

Build out `@osn/landing` — the OSN marketing site — from a bare scaffold into a
full static Astro + SolidJS + Tailwind v4 brochure, mirroring `@cire/landing`'s
stack and conventions.

Dark-grey, "your social graph, your control" identity built on a dotted /
network motif. Signature visuals are two self-contained Solid islands: a
`ConstellationCanvas` backdrop (an animated dot-network evoking the social
graph, mounted behind every page) and a `ConnectionsHero` whose person-graph
edges draw in on mount. Both honour `prefers-reduced-motion` (still field /
instant reveal) and degrade gracefully without a canvas context.

Sections (Promise, Features, How-it-works, Apps, Principles, FAQ, Final CTA)
plus a `SiteFooter` and draft privacy / terms legal pages. All copy is grounded
in real OSN features (own your graph, one identity → many profiles, apps
opt-in/out, passkey-only login, E2E privacy, data transparency); the ecosystem
section cross-sells Pulse, Zap and Cire. CTA targets and site metadata are
centralised in `lib/site.ts` (`PUBLIC_APP_URL` baked at build).

Fully static, no external images and no first-party API calls, so it ships the
same tight CSP (`_headers`) and `data-reveal` scroll-reveal primitive as
`@cire/landing`. Fonts: Space Grotesk + Inter. Dev/preview on port **4324**.
See `[[wiki/apps/osn-landing]]`.
