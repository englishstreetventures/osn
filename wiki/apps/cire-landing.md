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
last-reviewed: 2026-07-22
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

A marketing page should be **fully static** (best SEO + speed, no per-request
work). The guest site is per-request SSR (it resolves which wedding to render
from the path), so putting the brochure inside it would push a static page
through the SSR invite Worker and complicate the bare-domain redirect. Separate
packages deploy and scale on their own.

## Stack + brand parity

Mirrors `cire/organiser`: **static Astro + SolidJS islands + Tailwind v4**
(`output: "static"`, no Cloudflare adapter), deployed to Cloudflare Pages with
`wrangler pages deploy dist`. Motion via Motion One (`motion`), animation logic
isolated in `*.motion.ts` files (the cire convention).

The hero seal is the one exception to the Motion-One rule: it is a real **3D
object rendered with Three.js** (`three`, core only — no addons). Three.js is
heavy (~515 KB), so it stays **off the critical path**: `WaxSeal3D.tsx`
renders a flat CSS-disc poster server-side, then `import()`s the scene module
(`waxSealScene.ts`) on `requestIdleCallback` and cross-fades the WebGL canvas in
over the poster. The chunk is never `modulepreload`ed. The poster hides **only
after the scene's first frame paints** — an import/context/first-frame failure
leaves the poster, never an empty hero. No WebGL → poster stands in;
`prefers-reduced-motion` → the scene loads in **still mode** (one frame, no
settle/lean, repaint on resize only — reduced motion means no motion, not no
3D). Three.js and Motion One never share a component tree.

**Macrostructure: "The Unfolding Letter"** (redesign 2026-07-22). The page reads
top to bottom like opening and reading a single invitation. Display headings are
**roman** (`.display` in `global.css`) — italic stays on the wordmark logotype
and inside running body copy only (an all-italic heading is a reliable sign of
AI-written design). The whole page uses two eyebrows (hero + "See it live"). All
visible copy avoids the em-dash.

**Brand parity is deliberate**: `src/styles/global.css` keeps
the `@theme` token block **byte-identical** to `cire/web/src/styles/global.css`
(deep-green oklch palette, gold accent, Cormorant Garamond display + Lato body)
and loads the same Google Fonts. A visitor sees on the marketing page exactly
what their guests will see when they open the invite, so the site sells the
product by *being* a piece of it. **If you change a brand token in one, change it
in the other.**

## Page structure (`src/pages/index.astro`)

Composed as `Hero.astro` + seven section components under `components/sections/`.

1. **Hero** (`sections/Hero.astro` + `WaxSeal3D.tsx` + `waxSealScene.ts`) — a
   **real 3D wax seal** rests at the top of the sealed letter, built as a
   **stamping simulation**: each mount pours a random wax puddle (`pourWax()` —
   silhouette harmonics + run-out tongues) and presses a perfect-circle die into
   it, so every visitor's seal differs a little. The die carries a laurel wreath
   + italic "C" (canvas bump map, paired with a canvas **roughness map** so the
   pressed design reads burnished against the matte field) on a waxy
   `MeshPhysicalMaterial`, lit by a warm gold key against a cool forest fill. It
   is **ambient** — it never breaks — and it **never rotates on its own**: it
   rests in a fixed pose, leans toward the pointer, and settles on load. The rAF
   loop **sleeps at steady state** (woken by pointer/resize/visibility), so a
   static seal costs zero GPU. Shaders compile via `compileAsync` before the
   first frame. The seal is **decorative only**: the eyebrow, headline, subtext
   and both CTAs are server-rendered siblings, always painted, keyboard-operable
   with a real focus ring — so no JS / no WebGL / reduced motion still reads and
   works (the old `WaxSealHero` hid all hero content behind `display:none` until
   JS opened it; this does not).
2. **Promise** (`sections/Promise.astro`) — "the letter unfolds": the editorial
   "paper vs soulless e-invite vs Cire" passage in a narrow column.
3. **Features** (`sections/Features.astro`) — read *down* the card, not five
   identical alternating rows: two lead image/text splits (the opening, the RSVP)
   then a three-item text index of the rest. Every feature is something cire
   actually ships. See [[cire]].
4. **How it works** (`sections/HowItWorks.astro`) — three steps as a vertical
   numbered sequence (design → share one link → watch RSVPs), not a 3-column grid.
5. **See it live** (`demo/DemoRsvp.tsx`) — a real, in-page interactive invitation
   whose RSVP is a deliberate **no-op** (see below). `client:visible`.
6. **Craft / trust** — privacy-first, guests need no account, your data is yours.
7. **Testimonials** (`sections/Testimonials.astro`) — **fully designed but hidden**
   behind `SHOW_TESTIMONIALS = false`; renders nothing until we have real,
   permissioned quotes. We don't fabricate social proof.
8. **FAQ** — native `<details>` accordion, works with zero JS.
9. **Final CTA + footer** — repeats the primary CTA; `SiteFooter.astro` is a
   sign-off statement (a small wax mark echoing the hero seal) carrying the
   `/privacy` + `/terms` + `/refunds` links (the legal pages are review drafts).

A minimal fixed masthead (`SiteNav.astro`) — wordmark + the one primary CTA —
sits over the hero and gains a hairline + blurred wash once scrolled (toggled by
an `IntersectionObserver` sentinel, no per-frame scroll handler).

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
you send here is saved" banner (`RsvpModal`'s `preview` prop). A host can now walk
the exact guest RSVP flow without adding rows to their own RSVP data.

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
  `stroke-dasharray:1`; a passive-scroll + `requestAnimationFrame` loop maps
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
and each image shows the required photo credit. The CSP in `public/_headers`
allow-lists `images.unsplash.com` for `img-src`.

## Configuration (`src/lib/site.ts`, all build-time `PUBLIC_*`)

- `PUBLIC_ORGANISER_URL` — target of the primary "Create your invitation" CTA.
  Dev default is the local organiser (`http://localhost:4322`); end-state prod is
  `https://host.cireweddings.com`. **Held in one place, so the apex cutover is
  one env change and not a search through the code.**
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
4. ~~Redeploy osn-api manually~~ — osn-api is now CI-deployed (`deploy-osn-api`
   in `deploy.yml`, added 2026-07-16); `OSN_ORIGIN` picks up on the next merge.
5. Cleanup PR — **DONE 2026-07-16**: pruned the transitional apex + `app.` from
   cire-api `WEB_ORIGIN` and `app.` from osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN`
   (`cire/web`'s Worker route was already `invite.`-only, no apex route to drop).
   **Remaining manual dashboard step:** remove the `app.cireweddings.com` custom
   domain from the `cire-organiser` Pages project so `app.` stops resolving.

## Roadmap — toward a wedding platform

Cire's longer-term plan is to compete with all-in-one suites (withjoy.com): not
just the invitation, but the whole wedding **management platform** run from the
organiser dashboard. Tracked, not yet built:

- **Registry** — gift registry as a first-class surface (parity with withjoy).
- **Wedding-management platform** — budget, vendors, seating, schedule/timeline,
  guest communications — built out from the organiser portal (`host.cireweddings.com`).
- **Marketing depth** — pricing page, real testimonials (flip `SHOW_TESTIMONIALS`
  once permissioned), case studies, blog/SEO content.

The data model is already multi-tenant (`weddings` root), so growing into a
platform is a product decision, not a migration — see [[cire]].

## Deferred

- **Wax-seal fidelity** — the hero seal is a real 3D object (`waxSealScene.ts`)
  built **procedurally** (stamping simulation + canvas bump/roughness maps). A
  sculpted GLTF seal (Blender, with a proper normal + roughness bake) would read
  richer still; deferred until there is an asset pipeline for it. Swap point is
  `makeSealMesh()` — the lighting, pointer lean and PE fallback all stay. The
  seal is now visually verified: headless Chrome renders WebGL, so screenshot
  `bun run dev:landing` (`--headless=new --screenshot --virtual-time-budget`)
  when tuning `bumpScale` / lights / pour parameters.
- **Real photography** — imagery is still hotlinked Unsplash placeholders
  (`lib/site.ts` `IMAGES`); swap for the brand's own art when it exists.

## Related

- [[cire]] — the wedding-invite stack the landing page markets
- [[cire-auth]] — guest vs organiser auth (the two CTAs' destinations)
- [[production-deploy]] — secrets/vars + the cutover steps
- [[free-tier-limits]] — Cloudflare Free-tier ceilings the stack runs under
