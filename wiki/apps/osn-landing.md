---
title: OSN Landing
description: Marketing site for OSN — static Astro brochure emphasising user-owned connections and the opt-in app ecosystem
tags: [app, marketing]
status: active
packages:
  - "@osn/landing"
related:
  - "[[osn-core]]"
  - "[[social]]"
  - "[[pulse-landing]]"
  - "[[cire-landing]]"
last-reviewed: 2026-07-22
---

# OSN Landing

`@osn/landing` (`osn/landing`, dev port **4324**) is the **marketing site** for
OSN — the page that explains the platform thesis (you own your identity and your
social graph; apps opt in and out around it) and points visitors at the identity
/ social app (`@osn/social`). It is a pure brochure: no OSN auth, no first-party
API calls.

## Stack

Same stack as [[cire-landing]]: **static Astro + SolidJS islands + Tailwind v4**
(`output: "static"`, no Cloudflare adapter), Motion One available (`motion`) but
the signature visuals use plain canvas + `requestAnimationFrame`. Builds to plain
HTML (`astro build`), deployable to Cloudflare Pages like the other static sites.

- Fonts: **Space Grotesk** (display) + **Inter** (body), loaded with the same
  preload + `noscript` strategy as `cire/landing`.
- Tokens: a dark-grey oklch palette in `src/styles/global.css` (`@theme`) with a
  calm blue/indigo accent (`--color-accent`) and a cyan secondary
  (`--color-accent-2`), plus a reusable `.dot-grid` background utility for the
  dotted motif.
- Shared primitives ported from `cire/landing`: the `[data-reveal]`
  scroll-reveal utility + its `IntersectionObserver` bootstrap in
  `BaseLayout.astro`, and the reduced-motion global opt-out.

## Visual identity — dotted / network motif

Two self-contained Solid islands carry the "your social graph" idea:

- **`ConstellationCanvas.tsx`** (`client:load`, mounted in `BaseLayout` behind
  every page, like cire's `VineCanvas`) — an animated field of dots with thin
  links drawn between near neighbours, a picture of a social graph. The layer is
  **`position: fixed` and the canvas is sized to the viewport** (not the full
  document), so the backing store stays a few MB no matter how long the page is;
  it sits at `z-index:-1`, low opacity, `pointer-events:none`. Node count is
  capped by viewport area; the rAF loop pauses on `visibilitychange` and is
  cleaned up in `onCleanup`.
- **`ConnectionsHero.tsx`** (`client:load`, full-screen `min-h-[100svh]`) — the
  hero. A small person-graph whose edges draw in sequentially on mount, around an
  ownership-themed headline + two CTAs ("Get started" → app, "Explore the
  ecosystem" → `#apps`).

Both honour `prefers-reduced-motion` (render a still final state, no animation
loop) and stop cleanly when no 2-D context exists (so they render statically
under jsdom / SSR). No `console.*` anywhere (observability rule).

> Implementation note: the canvas draw/resize/render closures are written as
> arrow `const`s (not hoisted `function` declarations) so TypeScript keeps the
> non-null narrowing of the 2-D context past the `if (!ctx) return` guard.

## Page structure (`src/pages/index.astro`)

1. **Connections hero** — signature graph animation + headline + CTAs.
2. **Promise** — the thesis: decouple the social graph from apps; you own
   identity + relationships.
3. **Features** — benefits, grounded in real OSN capabilities: own your graph
   (connections, close friends, block-once-applies-everywhere), one identity →
   many profiles, apps opt-in/out, privacy by design (E2E messaging, granular
   visibility, hidden attendance), passwordless + secure (passkey-only login,
   recovery codes, per-device sessions), data transparency. See [[osn-core]],
   [[social]], [[passkey-primary]].
4. **Apps** (`id="apps"`) — the ecosystem: [[pulse]], [[zap]], [[cire]], each an
   independent opt-in.
5. **Principles** — modularity, data transparency, privacy by design, open
   standards (OIDC, self-hosting planned).
6. **FAQ** — native `<details>` accordion, works with zero JS.
7. **Final CTA + footer** — repeats the primary CTA; `SiteFooter.astro` carries
   `/privacy` + `/terms` (present as review drafts).

## Configuration

`src/lib/site.ts` is the single source of truth for external targets + metadata
(`SITE_NAME`, tagline, description, anchors). CTA targets are build-time env:

| Var | Purpose | Dev default |
|---|---|---|
| `PUBLIC_APP_URL` | Primary CTA → the OSN identity / social app | `http://localhost:1422` |
| `PUBLIC_DOCS_URL` | Optional docs / source link | unset |
| `SITE` | Canonical origin for SEO meta (placeholder `https://osn.social`) | config default |

`public/_headers` ships a tight CSP: no external image host (`img-src 'self'
data:`), Google Fonts allowed in `style-src` / `font-src`, immutable cache on
`/_astro/*`.

## Tests

`ConnectionsHero.test.tsx` renders the hero under jsdom (no canvas context) and
asserts the headline + CTA targets — the reduced-motion / no-context path, so it
passes regardless of canvas support. Run with
`bun run --cwd osn/landing test:run`.

## Deferred

- **CI deploy** — no deploy workflow yet (cf. cire's `deploy-landing-preview.yml`);
  add one + a Pages project when a hosting domain is chosen.
- **Real domain** — `SITE` / `PUBLIC_APP_URL` use placeholders until OSN's
  marketing + app hosts are decided.
- **Marketing depth** — pricing, deeper feature pages, SEO/blog content.
