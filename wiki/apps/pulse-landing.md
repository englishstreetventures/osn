---
title: Pulse Landing
description: Marketing site for Pulse events — colourful static Astro brochure following the Pulse design system
tags: [app, events, marketing]
status: active
packages:
  - "@pulse/landing"
related:
  - "[[pulse]]"
  - "[[osn-landing]]"
  - "[[cire-landing]]"
  - "[[venues]]"
last-reviewed: 2026-07-22
---

# Pulse Landing

`@pulse/landing` (`pulse/landing`, dev port **4325**; root script
`dev:pulse-landing`) is the **marketing site** for Pulse — the events app. It
sells the "what's happening near you" idea and points visitors at the Pulse app.
Pure brochure: no Pulse API calls, no account.

## Stack

Same stack as [[cire-landing]] and [[osn-landing]]: **static Astro + SolidJS
islands + Tailwind v4** (`output: "static"`). Signature animation is SVG +
CSS / `requestAnimationFrame` (Motion One is a declared dep for parity but not
imported). Builds to plain HTML, deployable to Cloudflare Pages.

Branding follows the Pulse design system — see `pulse/DESIGN.md`:

- Fonts: **Instrument Serif** (editorial display, italic accent word), **Geist**
  (UI/body), **Geist Mono** (eyebrow / meta), loaded via the shared preload +
  `noscript` strategy.
- Tokens in `src/styles/global.css` (`@theme`): the coral/ember/peach accent
  family shared with the app (`--pulse-accent*`), warm-tinted neutrals on a
  warm-light base, plus a vivid `--cat-1..6` palette for the category showcase.
- Shared primitives ported from `cire/landing`: the `[data-reveal]` scroll-reveal
  utility + its `IntersectionObserver` bootstrap, and the reduced-motion opt-out.

## Visual identity — colourful + fun

The brief is "colourful and fun" — the bright counterpart to [[osn-landing]]'s
restrained dark site. Two Solid islands:

- **`PulseField.tsx`** (`client:load`, mounted in `BaseLayout` behind every page)
  — a field of colourful pulsing dots / radiating rings in the category palette,
  echoing the app's pulsing-coral-dot mark. Low opacity, `pointer-events:none`,
  spans the page.
- **`PulseHero.tsx`** (`client:load`, `min-h-[100svh]`) — an editorial headline
  with an italic accent word, decorative floating chips (desktop only), a
  **location-aware "near you" line**, and two CTAs. All hero content is
  **server-rendered visible** (the entrance is the pure-CSS `.pulse-rise`
  animation), so it never waits on JS; `client:load` only *enhances* it with the
  geo hook below.

Both honour `prefers-reduced-motion` (still field / instant reveal / CSS
entrance only) and contain no `console.*`.

### Location-aware hero (`/api/geo`)

The hero deliberately shows **no account-specific stats** (we don't know the
visitor yet). Instead a Cloudflare **Pages Function** at
`pulse/landing/functions/api/geo.ts` reads the visitor's coarse, IP-derived
location from `request.cf` (city / region / country) and returns it as JSON.
`PulseHero` fetches `/api/geo` on mount and upgrades:

- the "near you" line → `"{n} events around {region} right now"`, and
- the primary CTA → `"What's on in {city}"` linking to `${APP_URL}?near={city}`.

Same-origin, so the tight CSP (`connect-src 'self'`) is untouched. Fully
progressive: no JS / fetch failure / function absent → the generic "near you"
copy + plain `Find events` CTA remain (the hero is never blank). `wrangler pages
deploy` bundles the function automatically from the `functions/` directory. **The event count is an illustrative placeholder**
(deterministic per place) until the real Pulse events API is wired; the region
and city are real.

## Page structure (`src/pages/index.astro`)

1. **Pulse hero** — signature pulsing-dot energy + editorial headline + the
   location-aware "near you" line + CTAs (see above).
2. **Promise** — the thesis: the social ease of FB Events + the fun of
   Partiful/Luma + the tooling of Eventbrite; "what's happening today near you".
3. **Features** — **four** colourful glyph/gradient cards (no photos): discovery
   by location/category/friends, effortless RSVPs, calendar + iCal export, and
   venue pages / nightly lineups. (Kept deliberately tight; "what's on near you"
   is the hero's job, not a card.) See [[pulse]].
4. **How it works** — discover → RSVP in a tap → show up.
5. **Categories** — the most colourful section: vivid per-category chips driven by
   `CATEGORIES` in `lib/site.ts`, each in its own `--cat-*` colour.
6. **Venues** — a stylised faux lineup timeline (mono time + act), a preview of
   the real venue-page feature. See [[venues]].
7. **FAQ** — native `<details>` accordion.
8. **Final CTA + footer** — repeats the primary CTA; `SiteFooter.astro` carries
   `/privacy` + `/terms` (review drafts).

## Configuration

`src/lib/site.ts` holds `SITE_*` metadata, the `CATEGORIES` list (label + glyph +
colour token), and the CTA target:

| Var | Purpose | Dev default |
|---|---|---|
| `PUBLIC_APP_URL` | Primary CTA → the Pulse app | `http://localhost:3001` |
| `SITE` | Canonical origin for SEO meta (placeholder `https://pulse.events`) | config default |

`public/_headers` ships the same tight CSP as the other static sites (no external
image host; Google Fonts allowed; immutable `/_astro/*`). `connect-src 'self'`
deliberately allows the same-origin `/api/geo` fetch (the only network call).

The site is otherwise pure-static, but the `functions/` directory makes the Pages
deploy a hybrid (static assets + one Pages Function); `wrangler pages deploy dist`
bundles it automatically.

## Tests

`PulseHero.test.tsx` renders the hero and asserts the headline + the geo
*fallback* CTA (no `/api/geo` in the test env). Run with
`bun run --cwd pulse/landing test:run`. The `/api/geo` function logic is simple
and edge-only (`request.cf`), so it is exercised at deploy rather than unit-mocked.

## Deferred

- **Real events count** — `/api/geo` returns an illustrative, deterministic count
  per place; wire it to the real Pulse events API for live numbers. The region +
  city it resolves are already real.
- **"State's main city" mapping** — the CTA currently targets the visitor's
  nearest Cloudflare city; a region → capital/major-city table would let small
  towns route to their state's main city instead.
- **Real domain** — `SITE` / `PUBLIC_APP_URL` are placeholders until the Pulse
  marketing + app hosts are decided. (Preview deploys to `osn-pulse-landing.pages.dev`
  via `.github/workflows/deploy-osn-pulse-landing.yml`.)
- **Marketing depth** — screenshots/imagery once brand assets exist, deeper
  feature pages, SEO content.
