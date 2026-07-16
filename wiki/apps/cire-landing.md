---
title: Cire Landing
description: Marketing site for the apex cireweddings.com — static Astro brochure for the cire wedding-invite product
tags: [app, weddings, marketing]
status: active
packages:
  - "@cire/landing"
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[production-deploy]]"
  - "[[free-tier-limits]]"
last-reviewed: 2026-07-16
---

# Cire Landing

`@cire/landing` (`cire/landing`, dev port **4323**) is the **marketing site** for
Cire — the page a prospective couple lands on at the apex `cireweddings.com`. It
is a separate concern from the per-wedding guest invites (`cire/web`) and the
organiser portal (`cire/organiser`), and is built and deployed as its own
package.

## Why a separate package

Three clean concerns, three packages, mapping onto the end-state domains:

| Surface | Package | End-state host |
|---|---|---|
| Marketing | `@cire/landing` | apex `cireweddings.com` |
| Invites (guest) | `@cire/web` | `invite.cireweddings.com` |
| Organiser portal | `@cire/organiser` | `host.cireweddings.com` |

A marketing page wants to be **fully static** (best SEO + speed, no per-request
work). The guest site is per-request SSR (it resolves which wedding to render
from the path), so folding the brochure into it would tangle a static page into
the SSR invite Worker and fight the bare-domain redirect. Keeping them apart lets
each deploy + scale independently.

## Stack + brand parity

Mirrors `cire/organiser`: **static Astro + SolidJS islands + Tailwind v4**
(`output: "static"`, no Cloudflare adapter), deployed to Cloudflare Pages with
`wrangler pages deploy dist`. Motion via Motion One (`motion`), animation logic
isolated in `*.motion.ts` files (the cire convention).

**Brand parity is a feature, not a coincidence**: `src/styles/global.css` keeps
the `@theme` token block **byte-identical** to `cire/web/src/styles/global.css`
(deep-green oklch palette, gold accent, Cormorant Garamond display + Lato body)
and loads the same Google Fonts. What a visitor sees on the marketing page is
exactly what their guests will feel opening the invite — so the site sells the
product by *being* a piece of it. **If you change a brand token in one, change it
in the other.**

## Page structure (`src/pages/index.astro`)

1. **Wax-seal hero** (`WaxSealHero.tsx` + `WaxSeal.motion.ts`) — the signature
   interaction. The **whole first screen is the front of a sealed envelope** (a
   full-bleed flap + body with pocket seams and a gold wax disc, monogram "C", at
   its heart). The seal lifts, the flap swings open about its top hinge, and the
   envelope fades away to unveil the headline + CTAs beneath. Opens on tap
   (anywhere)/keyboard, or auto-opens after a beat. Honours
   `prefers-reduced-motion` (snaps open). `client:load` — first paint, and the
   thesis of the product in one gesture.
2. **Promise** — the editorial "paper vs soulless e-invite vs Cire" passage.
3. **Features** — alternating image/text rows; every feature is something cire
   actually ships (reveal animation, per-guest greetings, live RSVPs, details/
   maps/calendar, theming/moodboards). See [[cire]].
4. **How it works** — three steps (design → share one link → watch RSVPs).
5. **See it live** (`demo/DemoRsvp.tsx`) — a real, in-page interactive invitation
   whose RSVP is a deliberate **no-op** (see below). `client:visible`.
6. **Craft / trust** — privacy-first, guests need no account, your data is yours.
7. **Testimonials** (`sections/Testimonials.astro`) — **fully designed but hidden**
   behind `SHOW_TESTIMONIALS = false`; renders nothing until we have real,
   permissioned quotes. We don't fabricate social proof.
8. **FAQ** — native `<details>` accordion, works with zero JS.
9. **Final CTA + footer** — repeats the primary CTA; `SiteFooter.astro` carries
   the `/privacy` + `/terms` links (the legal pages are present as review drafts).

## Interactive no-op RSVP demo

The "See it live" section renders a working invitation in miniature. Guests can
pick events, toggle attendance per person, type a dietary note and "Send RSVP" —
everything is interactive, but **nothing leaves the browser**: a valid submit
shows a confirmation panel making the no-op explicit, and never calls any API
(`DemoRsvp.test.tsx` asserts `fetch` is never invoked). This lets the page *show*
the product instead of describing it.

The **same no-op treatment** was applied to the organiser **host preview** in
`cire/web`: the RSVP there used to be greyed out (`disabled` in preview mode).
It is now fully interactive, with submit short-circuited to a no-op and a "Nothing
you send here is saved" banner (`RsvpModal`'s `preview` prop). A host can now feel
the exact guest RSVP flow without polluting their own RSVP data.

## Generative vine backdrop

A procedural botanical backdrop runs behind the whole page (`VineCanvas.tsx` +
`lib/vines/`). Vines emerge from the left/right page edges, meander down and
inward, curl into logarithmic-spiral tendrils, and carry golden-angle
(phyllotactic) leaves + the occasional flower — and they **"grow" (draw on) as
you scroll past them**.

- **Procedural + seeded.** A pure, deterministic generator (`lib/vines/generate.ts`)
  builds the field from a seed via a seedable PRNG (`prng.ts`: xmur3 + mulberry32)
  and a Catmull-Rom → cubic-Bézier smoother (`geometry.ts`). Stems are a
  turtle-walk with layered sine+brownian curvature; branching is depth- and
  budget-limited so it never becomes a bush. Same seed ⇒ same plant.
- **SSR roots, client growth.** The server prerenders a deterministic baseline
  (stable roots + a fully-drawn static field — also the no-JS / reduced-motion
  fallback). On mount the client measures the real document, regenerates with a
  **fresh per-load seed** (so every visit is subtly different), and animates.
- **Scroll-linked draw-on.** Stems are STROKED with `pathLength="1"` +
  `stroke-dasharray:1`; a lean passive-scroll + `requestAnimationFrame` loop maps
  each vine's document band to a single CSS custom property `--p` (0→1), and CSS
  draws the stroke (`stroke-dashoffset: calc(1 - var(--p))`) and fades the
  leaves/flowers in just behind the growth front. One property write per in-view
  vine per frame; `prefers-reduced-motion` shows the vines fully drawn. (Chosen
  over CSS `view()` scroll-timelines because SVG sub-elements aren't reliably
  tracked by view-timelines, and the JS map gives exact per-vine document
  positioning. The `lib/vines/` math is unit-tested for determinism.)

## Imagery

Photography is **hotlinked from Unsplash's CDN** (`images.unsplash.com`) — the
build never downloads the assets; the visitor's browser loads them directly,
which is how Unsplash intends hosted images to be used. Every image is composed
in `src/lib/site.ts` (`IMAGES` map + `unsplash()` helper) so swapping in the
brand's / couple's own art is a one-line change. Each `<img>` paints over a gold
gradient (`Figure.astro`) so a slow or blocked load never leaves an empty hole,
and the required photo credit is surfaced per image. The CSP in `public/_headers`
allow-lists `images.unsplash.com` for `img-src`.

## Configuration (`src/lib/site.ts`, all build-time `PUBLIC_*`)

- `PUBLIC_ORGANISER_URL` — target of the primary "Create your invitation" CTA.
  Dev default is the local organiser (`http://localhost:4322`); end-state prod is
  `https://host.cireweddings.com`. **Centralised so the apex cutover is one env
  change, not a code hunt.**
- `PUBLIC_DEMO_INVITE_URL` — optional. When set, "See a live invite" links to a
  real seeded invitation; unset, it scrolls to the in-page interactive demo.
- `SITE` — canonical origin for SEO meta (`astro.config` `site`).

## Deploy + the domain migration

**Apex cutover — done in code 2026-07-16 (domain reshuffle).** End state: apex
`cireweddings.com` → this landing site; `invite.cireweddings.com` → guest site
(`cire/web`); `host.cireweddings.com` → organiser portal (`cire/organiser`, moved
off `app.cireweddings.com`). CI job `deploy-cire-landing` in
`.github/workflows/deploy.yml` mirrors `deploy-cire-organiser` (the `cire-landing`
Pages project must exist in the account before first run).

**Passkey safety:** prod `OSN_RP_ID = cireweddings.com` (the registrable apex), so
WebAuthn credentials are scoped to the whole domain — moving the organiser portal
`app.` → `host.` does NOT invalidate existing organiser passkeys (no
re-registration). Only the origin allowlists gain `host.`; `app.` + the old apex
stay in the allowlists for the switchover window, then get pruned.

The code side (this PR): `cire/web/wrangler.jsonc` route → `invite.`; deploy.yml
`PUBLIC_SITE_URL` → `invite.`, `PUBLIC_CIRE_WEB_URL` → `invite.`,
`PUBLIC_ORGANISER_URL` → `host.`, landing `SITE` → apex; cire-api `WEB_ORIGIN` +
osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN` gain `invite.`/`host.` (keep `app.`/apex for
the window). **No apex 301 for old invite links — decided 2026-07-16 there are no
apex-based invite links in the wild (guests use the full link).**

Remaining **manual** steps (Cloudflare dashboard + one deploy), sequenced in
[[production-deploy]]:
1. Attach `host.cireweddings.com` custom domain → `cire-organiser` Pages.
2. Attach apex `cireweddings.com` → `cire-landing` Pages (Cloudflare offers to
   *move* it off the `cire-invites` Worker — confirm).
3. Confirm `invite.cireweddings.com` auto-provisioned on the `cire-invites` Worker
   (custom_domain on deploy).
4. Redeploy osn-api manually (`cd osn/api && bunx wrangler deploy --env production`)
   — it is NOT in CI — so `OSN_ORIGIN` picks up `host.`.
5. Cleanup PR: drop apex route from the Worker config; prune `app.`/apex from the
   allowlists.

## Roadmap — toward a wedding platform

Cire's longer-term vision is to compete with all-in-one suites (withjoy.com): not
just the invitation, but the whole wedding **management platform** run from the
organiser dashboard. Tracked, not yet built:

- **Registry** — gift registry as a first-class surface (parity with withjoy).
- **Wedding-management platform** — budget, vendors, seating, schedule/timeline,
  guest communications — built out from the organiser portal (`host.cireweddings.com`).
- **Marketing depth** — pricing page, real testimonials (flip `SHOW_TESTIMONIALS`
  once permissioned), case studies, blog/SEO content.

The data model is already multi-tenant (`weddings` root), so platformising is a
product decision, not a migration — see [[cire]].

## Deferred

- **Wax-seal graphic** — the hero's seal disc (`WaxSealHero.tsx`) is a
  PLACEHOLDER (gold radial-gradient + Cormorant "C" monogram). It is to be
  replaced by a separately designed wax-seal asset. The component is structured
  so only the inner seal `<div>` needs swapping — the full-page envelope, the
  open/seal-break animation (`WaxSeal.motion.ts`) and all wiring stay. Marked
  with `TODO(design)` in the source.

## Related

- [[cire]] — the wedding-invite stack the landing page markets
- [[cire-auth]] — guest vs organiser auth (the two CTAs' destinations)
- [[production-deploy]] — secrets/vars + the cutover steps
- [[free-tier-limits]] — Cloudflare Free-tier ceilings the stack runs under
