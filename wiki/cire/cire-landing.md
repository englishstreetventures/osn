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
  - "[[dev-environment]]"
  - "[[cire-consent]]"
  - "[[cire-plus-ones]]"
  - "[[testing-patterns]]"
  - "[[cire-entitlements]]"
  - "[[cire-upgrades]]"
  - "[[cire-organiser]]"
last-reviewed: 2026-10-29
---

# Cire Landing

`@cire/landing` (`cire/landing`, dev port **4323**) is the **marketing site** for
Cire — the page a prospective couple lands on at the apex `cireweddings.com`. It
is a separate concern from the per-wedding guest invites (`cire/invites`) and the
organiser portal (`cire/host`), and is built and deployed as its own
package.

## Why a separate package

Three clean concerns, three packages, mapping onto the end-state domains:

| Surface | Package | End-state host |
|---|---|---|
| Marketing | `@cire/landing` | apex `cireweddings.com` |
| Invites (guest) | `@cire/invites` | `invite.cireweddings.com` |
| Organiser portal | `@cire/host` | `host.cireweddings.com` |

A marketing page should be **fully static** (best SEO + speed, no per-request
work). The guest site is per-request SSR (it resolves which wedding to render
from the path), so putting the brochure inside it would push a static page
through the SSR invite Worker and complicate the bare-domain redirect. Separate
packages deploy and scale on their own.

## Stack + brand parity

Mirrors `cire/host`: **static Astro + SolidJS islands + Tailwind v4**
(`output: "static"`, no Cloudflare adapter), deployed to Cloudflare Pages with
`wrangler pages deploy dist`. **Motion is CSS alone**: transitions and one
keyframe animation, no motion library. `motion` and `three` are not
dependencies, and the bundle guard's threshold (`scripts/bundle-size-budgets.txt`)
sits at the measured build plus the usual headroom, so adding either fails the
build. The reduced-motion block in `src/styles/global.css` snaps every
transition and animation off; the demo sheet's `Modal` (`@shared/ui`) checks the
same media query itself. `html` sets `color-scheme: dark`, so the browser's own
controls and scrollbars match the one dark palette, and `scroll-padding-top:
5rem`, so an in-page link or a focused control lands below the fixed masthead.

**Macrostructure: "The invitation is the page"** (owner, 2026-10-29). The first
screen is a finished invitation, and the page sells the product by showing it
from both sides: what a guest holds, and what the couple run it from. Display
headings are **roman** (`.display` in `global.css`): italic stays on the
wordmark logotype, the seal's monogram and inside running body copy only. The
whole page uses two eyebrows (hero + "See it live"). No visible copy uses the
em-dash or the word "premium" (Classic and Gala are free;
`tools/e2e/tests/flows/cire-landing-home.flow.ts` checks both over every text
node, hidden states included).

**Brand parity is deliberate**: `src/styles/global.css` keeps
the `@theme` token block **byte-identical** to `cire/invites/src/styles/global.css`
(deep-green oklch palette, gold accent, Cormorant Garamond display + Lato body)
and loads the same Google Fonts. A visitor sees on the marketing page exactly
what their guests will see when they open the invite, so the site sells the
product by *being* a piece of it. **If you change a brand token in one, change it
in the other.**

## Page structure (`src/pages/index.astro`)

`SiteNav`, then one `<main>` holding the sections below, then `SiteFooter`.
Each section is a component under `components/sections/`; the drawings of the
product are under `components/mock/` ([[#Product views]]).

| # | Section (id) | Component | What it does |
|---|---|---|---|
| 1 | Hero (`#hero`) | `Hero.astro` | Eyebrow, the h1 "Invitations worthy of the moment", a 16-word subhead, "Create your invitation" and "See a live invite". Under them a fan of five phones: the middle one is the sample wedding's invitation, the four around it dashed "?" silhouettes. Four chips switch the middle phone between **Sealed**, **Opened**, **RSVP** and **On the day** |
| 2 | See it live (`#see-it-live`) | `SeeItLive.astro` + `demo/DemoRsvp.tsx` | The working no-op RSVP ([[#Interactive no-op RSVP demo]]). `client:visible` |
| 3 | Journey (`#journey`) | `Journey.astro` | Five tabs (Invite, RSVP, Seating, On the day, Gifts); each shows the guest's phone beside the couple's dashboard. Seating, On the day and Gifts carry "Included in Gold" |
| 4 | Pricing (`#pricing`) | `Pricing.astro` | The three plans ([[#Pricing]]) |
| 5 | Craft / trust | `Craft.astro` | Privacy-first, guests need no account, your data is yours. The site's one photograph |
| 6 | Testimonials | `Testimonials.astro` | **Designed but hidden** behind `SHOW_TESTIMONIALS = false`; renders nothing until there are real, permissioned quotes. We don't fabricate social proof |
| 7 | FAQ (`#faq`) | `Faq.astro` | Native `<details>`, works with zero JS. Its cost answer gives the plan prices |
| 8 | Closing (`#cta`) | `FinalCta.astro` | The one-to-one message a guest receives (the portal's three-line message, its link and the household's code) and the "Your names" field ([[#The claim field]]) |

Every organiser link (nav, hero, the three plans, the closing field, the
footer) points at `ORGANISER_URL` and reads "Create your invitation", or "Create
an invitation" in the footer. The footer's section links go to `/#journey`,
`/#pricing` and `/#faq`.

A minimal fixed masthead (`SiteNav.astro`) — wordmark + the one primary CTA —
sits over the hero and gains a hairline + blurred wash once scrolled (toggled by
an `IntersectionObserver` sentinel, no per-frame scroll handler).

### Chips and tabs without script

The hero's chips and the journey's tabs are native radios in a `<fieldset>`
with a visually hidden `<legend>` ("Show the invitation", "Choose a step").
The radios come first in the fieldset, so CSS sibling selectors do the work:
`#hs-opened:checked ~ .stage [data-state='opened']` shows a screen and
`#hs-opened:focus-visible ~ .chips [for='hs-opened']` draws the 2px gold focus
ring, offset 4px, on its chip. No island and no `:has()`, which Firefox 114–120
on the browser floor lacks. They switch with JavaScript off, and the arrow keys
move between them as between any radios.

- **A fieldset, not `role="radiogroup"`.** The group has to hold the phones as
  well as the radios, so the radios can sit before them, and a radiogroup may
  own only radios.
- **The hidden radios sit where their labels are** (the chips' row, the tab
  bar). Clicking a label focuses its radio, and the browser scrolls a focused
  element into view; a radio parked elsewhere would jump the page.
- **All states share one grid cell**, so switching never moves the page.
  Inactive ones are `opacity: 0; visibility: hidden`; the change is a 0.45s
  opacity and 0.5rem rise, and `transition: none` under reduced motion.
- **Chips are at least 44px tall.** At 390px the four fit on one row by
  dropping their tracking to 0.08em.

## Product views

The page shows the product as drawings in landing tokens, never screenshots: a
drawing cannot drift from the brand when the portal's own look changes, and it
carries only synthetic data.

- **The sample wedding.** Amara & Sam, Saturday 20 March 2027, Byron Bay: the
  ceremony at Cliffside Chapel, the reception at The Glasshouse (the demo RSVP's
  two events). The hero, journey and closing follow one household, the Okafors
  (Chidi and Ngozi), whose code is `AMR-7Q2K` and whose link is
  `invite.cireweddings.com/cire/invite?slug=amara-sam-4c1e9a`. Every dashboard
  drawing says "Sample wedding".
- **`PhoneFrame.astro`** draws a phone; `variant="placeholder"` is a dashed
  silhouette with a "?" and no screen, never captioned. Its corners are
  `0.15 × --phone-w`: the house cap of 6px is for controls and panels, and a
  phone's corners are part of its outline. Width comes from the parent through
  `--phone-w`, because under Astro's attribute scoping a parent's class cannot
  style a child component's root; a parent positions a wrapper of its own.
- **`InviteScreen.astro`** draws one guest screen (`sealed`, `opened`, `rsvp`,
  `replied`, `on-the-day`, `gifts`), in the guest site's own words where it has
  them ("Open Invitation", "Send RSVP"). The phone's screen is a size container
  and the type is set in `cqi`, so the screen scales with the phone at every
  breakpoint. Buttons and fields are `<span>`s: nothing on the page offers a
  press that does nothing.
- **`SealMark.astro`** is the CSS wax seal (a gold disc, unevenly round, with a
  monogram), sized by `--seal-size`.
- **Hidden from assistive technology.** Every phone is `aria-hidden`; the hero's
  `<figure>` carries a visually hidden caption for the chosen state, the
  closing thread one for the message, and the journey's views visible captions
  ("What a guest sees", "What you see").
- **Seating is the organiser's.** The guest phone on the Seating tab shows the
  household's reply, never a table: guests do not see the plan ([[cire-seating]]).
- **The link preview is text only.** The guest site sets no `og:*` tags, so the
  closing thread draws a plain card (host, names, "You're Invited") rather than
  an image.

**The fan.** The hero's `overflow-x: clip` keeps the outer phones from panning
the page.

| Width | Middle phone | Neighbours | Outer pair |
|---|---|---|---|
| < 640px | 10rem × 20rem | scale 0.82, ±62%, leaning in 5°, opacity 0.55 | not drawn |
| 640–1023px | 12.5rem wide | scale 0.84, ±66%, fanning out 5°, opacity 0.6 | scale 0.7, ±118%, 9°, opacity 0.35 |
| ≥ 1024px | 13.5rem wide | scale 0.86, ±72%, 6° | scale 0.72, ±132%, 10° |

At 390 × 844 the primary call to action sits above the fold and the middle
phone inside the screen; the flow checks both. The fan opens once on arrival
from a closed stack (0.9s, inside `prefers-reduced-motion: no-preference`).

## Pricing

`src/lib/plans.ts` holds the offer, and `Pricing.astro` renders it: Ivory free
for up to 100 guests, Gold A$79 for 500, Crimson A$149 for 1,000, each paid
once per wedding; a wedding on Gold moves to Crimson for A$70. Each plan lists
what it adds ([[cire-entitlements]]); Classic and Gala are free, so no plan
promises designs. Every plan's call to action is the same "Create your
invitation": a couple starts on Ivory and upgrades from the dashboard
([[cire-upgrades]]). Gold is the raised card, with the gold-filled button.

- **Guest caps and the tier list are tested.** `tests/lib/plans.test.ts` reads
  `TIERS` and `TIER_GUEST_CAP` out of `cire/api/src/services/tiers.ts` and fails
  when a cap, a tier or their order differs, or when it can no longer find them.
- **Prices are not.** What a host is charged is the Stripe Price the deployment
  configures, read back from Stripe; the amounts here are the published offer,
  checked by hand against those Prices before a release. Change a Price, change
  `plans.ts`.
- **Legal pages lag.** `/terms` and `/refunds` do not describe these tiers yet;
  englishstreetventures/osn#1317 holds that decision.

## The claim field

The closing section's "Your names" field previews the link Cire would make and
carries the names to the organiser portal.

- **The preview** reads `invite.cireweddings.com/cire/invite?slug=<slug>-······`.
  The slug comes from `slugPreview` in `src/lib/slug-preview.ts`, a copy of
  cire-api's `slugifyDisplayName` (`cire/api/src/lib/slug.ts`); the six dots
  are the suffix Cire adds. Empty, it shows `wedding-······`, as the API would.
  It is written with `textContent` and only ever shows the slug (`[a-z0-9-]`):
  the names themselves are echoed nowhere.
- **The call to action is a link**, `ORGANISER_URL/?name=<the trimmed names,
  encodeURIComponent>`, never a form: the CSP's `form-action 'self'` refuses a
  submit to another origin. Enter in the field follows it. The field's
  `maxlength` is 120, the API's limit.
- **Without JavaScript** the field does nothing and the link opens the portal
  with no name.
- **In the portal**, `WeddingList` reads `?name=`, opens the create form with
  the names in its field and drops the parameter from the address
  ([[cire-organiser#Arriving from the marketing site]]). A signed-out visitor keeps it
  through `/login?returnTo=`.
- **Held to the API by a test.** `tests/lib/slug-preview.test.ts` imports
  `cire/api/src/lib/slug.ts` and compares the two rules on a corpus of names
  (ampersands, accents, emoji, repeated spaces, punctuation, a 120-character
  name), and holds the field's cap, the API's and the portal's
  `MAX_DISPLAY_NAME` equal. A slug the couple choose themselves needs an API and
  schema change and is not offered.

## Privacy pages

Four pages, set by the owner on 2026-10-20: a common page and one notice for
each kind of person who uses Cire. Each notice carries its own "Last updated".

| Page | Source | Who it is for |
|---|---|---|
| `/privacy` | `src/pages/privacy/index.astro` | Everyone: who runs Cire, what the three notices say in short, rights and contact. Every statement on it is one a notice already makes |
| `/privacy/hosts` | `src/pages/privacy/hosts.astro` | Couples, co-hosts and organisers |
| `/privacy/guests` | `src/pages/privacy/guests.astro`, rendering `cire/ui/src/guest-privacy-notice.astro` | Invited households and the people they bring |
| `/privacy/vendors` | `src/pages/privacy/vendors.astro` | Wedding suppliers |

The site footer links `/privacy`, which links to the three notices. So does the
organiser portal's RSVP editor, under a plus-one's dietary attestation; the
portal reads this site's origin from `PUBLIC_MARKETING_URL`
(`CIRE_MARKETING_URL` in `cire/host/src/lib/osn.ts`).

**One guest notice, two sites.** The guest site renders the same component as
its own `/privacy` page, so a plus-one sent to cireweddings.com/privacy reaches
the same words one link on. The component takes a `choices` slot: the guest site
passes its button that opens the guest's privacy choices, which live on that
origin; here the slot is empty and the notice points at the invitation's footer.
Its cookie list is generated from the consent vendor registry, which lives in
`@cire/ui` with it ([[cire-consent]]).

**The hosts' and vendors' notices** share every section that applies to both;
what concerns only organisers (their accounts, guest information, purchases, who
changed a reply) is in the hosts' notice, and directory listings and a supplier's
own vendor-portal account in the vendors'.
Each points at the other in its first paragraph.

**`PrivacyNav.astro`** (`src/components/`) is the row of links across the top of
all four pages: Overview, Hosts, Guests, Vendors. Plain links in a `<nav>` named
"Privacy notices", the current page marked `aria-current="page"`. No JavaScript;
each page is its own URL and prints on its own, with the row left out.

**The look**, in landing tokens only, no new token:

- The row: four labels on a `--color-border` hairline, each as wide as its
  word, `1.75rem` apart, wrapping if they ever run out of room. Labels in the
  voice of the "Back to Cire" link — Lato `0.8125rem`, uppercase, `0.06em`
  tracking. Other pages `--color-text-muted`; the current one `--color-text`
  with a 2px `--color-gold` underline; hover `--color-text`; focus ring 2px
  `--color-gold`, offset 3px, as the CTAs and footer links draw theirs.
- Sections are `h2`, as on the other legal pages. The guest notice's sub-sections,
  and the four parts of the vendors' notice's "Your vendor account" section, are
  `h3`, drawn as the guest site draws its `h3`, in `--color-gold`
  (`layouts/LegalLayout.astro`).
- One dark palette, like the rest of the site: a light-scheme visit renders the
  same page.

`tools/e2e/tests/flows/cire-privacy-pages.flow.ts` follows the row through all
four pages, checks the current page is marked with JavaScript on and off, tells
the hosts' and vendors' notices apart, compares the guest notice with the guest
site's, prints, and screenshots each page at 390 and 1280 px.

## Interactive no-op RSVP demo

The "See it live" section, straight under the hero, renders a working
invitation in miniature for the sample wedding. Visitors can pick events, toggle
attendance per person, type a dietary note and "Send RSVP" — everything is
interactive, but **nothing leaves the browser**: a valid submit shows a
confirmation panel making the no-op explicit, and never calls any API.
`DemoRsvp.test.tsx` asserts `fetch` is never invoked, and gates merges; the
`cire-landing-home` flow also sends a reply in a real browser and records every
`fetch`, XHR, beacon and event-source request it makes, which must be none. This
lets the page *show* the product instead of describing it.

The organiser's **host preview** in `cire/invites` gets the same treatment: its
RSVP is fully interactive, with submit short-circuited to a no-op and a "Nothing
you send here is saved" banner (`RsvpPanel`'s `preview` prop), so a host can walk
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

The site carries **one photograph**, in the craft section; the product is shown
as drawings ([[#Product views]]). It is **hotlinked from Unsplash's CDN**
(`images.unsplash.com`) — the build never downloads it; the visitor's browser
loads it directly, which is how Unsplash intends hosted images to be used. It is
composed in `src/lib/site.ts` (`IMAGES.craft` + `unsplash()` helper) so swapping
in the brand's own art is a one-line change. The `<img>` paints over a gold
gradient (`Figure.astro`) so a slow or blocked load never leaves an empty hole,
and shows the required photo credit. The CSP in `public/_headers` allow-lists
`images.unsplash.com` for `img-src`.

## Configuration (`src/lib/site.ts`, all build-time `PUBLIC_*`)

- `PUBLIC_ORGANISER_URL` — target of every organiser link: the nav, the hero,
  the three plans, the closing field (with `/?name=` when the couple typed their
  names) and the footer. Dev default is the local organiser
  (`http://localhost:4322`); end-state prod is `https://host.cireweddings.com`.
  **Held in one place, so the apex cutover is one env change and not a search
  through the code.**
- `PUBLIC_DEMO_INVITE_URL` — optional, read by the hero only. When set, "See a
  live invite" links to a real seeded invitation; unset, it scrolls to the
  in-page interactive demo.
- `SITE` — canonical origin for SEO meta (`astro.config` `site`).

## Deploy + the domain migration

**Apex cutover — done in code 2026-07-16 (domain reshuffle).** End state: apex
`cireweddings.com` → this landing site; `invite.cireweddings.com` → guest site
(`cire/invites`); `host.cireweddings.com` → organiser portal (`cire/host`, moved
off `app.cireweddings.com`). In `.github/workflows/production-release.yml` the `sites`
job builds it with its production values and `deploy-cire-landing` deploys that build to
the `cire-landing` Pages project, which must exist in the account before the first run.
The cire stack deploys the same build to the staged `cire-landing` Worker on
`next.cireweddings.com` until the apex moves to it
([[infrastructure-as-code#Production sites]]). On dev the cire stack
serves it as the `cire-landing-dev` Worker, with static assets, on `cire.<DEV_DOMAIN>`,
a host derived from the `dev` Environment's `DEV_DOMAIN` variable
([[infrastructure-as-code#Dev hosts]]); `deploy.yml`'s cire stack job deploys and
smoke-checks it, and its record job `deploy-cire-landing-dev` leaves the dev
Deployment record. The apex job ships only in a production release, once dev has
deployed the same content and a human has approved the `production` GitHub
Environment. See [[dev-environment]] and [[production-deploy]].

**Passkey safety:** prod `OSN_RP_ID = cireweddings.com` (the registrable apex), so
WebAuthn credentials are scoped to the whole domain — moving the organiser portal
`app.` → `host.` does NOT invalidate existing organiser passkeys (no
re-registration). Only the origin allowlists gain `host.`; `app.` + the old apex
stay in the allowlists for the switchover window, then get pruned.

The code side (this PR): `cire/invites/wrangler.jsonc` route → `invite.`; deploy.yml
`PUBLIC_SITE_URL` → `invite.`, `PUBLIC_CIRE_WEB_URL` → `invite.`,
`PUBLIC_ORGANISER_URL` → `host.`, landing `SITE` → apex; cire-api `WEB_ORIGIN` +
osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN` gain `invite.`/`host.` (keep `app.`/apex for
the window). **No apex 301 for old invite links — decided 2026-07-16 there are no
apex-based invite links in the wild (guests use the full link).**

Remaining **manual** steps (Cloudflare dashboard + one deploy), sequenced in
[[production-deploy]]:
1. Attach `host.cireweddings.com` custom domain → the organiser portal's Pages project,
   `cire-host`, the one `deploy-cire-host` deploys and the project holding the domain.
2. Attach apex `cireweddings.com` → `cire-landing` Pages (Cloudflare offers to
   *move* it off the `cire-invites` Worker — confirm).
3. Confirm `invite.cireweddings.com` auto-provisioned on the `cire-invites` Worker
   (custom_domain on deploy).
4. ~~Redeploy osn-api manually~~ — osn-api is CI-deployed (`deploy-osn-api`
   in `production-release.yml`); `OSN_ORIGIN` picks up with the next release.
5. Cleanup PR — **DONE 2026-07-16**: pruned the transitional apex + `app.` from
   cire-api `WEB_ORIGIN` and `app.` from osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN`
   (`cire/invites`'s Worker route was already `invite.`-only, no apex route to drop).
   The organiser portal's Pages project (`cire-host`) holds `host.cireweddings.com`
   alone; `app.cireweddings.com` is not attached to it.

   *Measured 2026-10-28 — dashboard, Workers & Pages → `cire-host` → Custom domains: one row, `host.cireweddings.com`, Active.*

## Roadmap — toward a wedding platform

Cire's longer-term plan is to compete with all-in-one suites (withjoy.com): not
just the invitation, but the whole wedding **management platform** run from the
organiser dashboard. The gift registry, with money gifts and named cash funds,
is built ([[cire-registry]]). Tracked, not yet built:

- **Wedding-management platform** — budget, vendors, seating, schedule/timeline,
  guest communications — built out from the organiser portal (`host.cireweddings.com`).
- **Marketing depth** — real testimonials (flip `SHOW_TESTIMONIALS` once
  permissioned), case studies, blog/SEO content. Pricing is built
  ([[#Pricing]]).

The data model is already multi-tenant (`weddings` root), so growing into a
platform is a product decision, not a migration — see [[cire]].

## Deferred

- **Real photography** — the craft image is still a hotlinked Unsplash
  placeholder (`lib/site.ts` `IMAGES`); swap for the brand's own art when it
  exists.
- **More designs in the fan** — the hero's four "?" phones stand where designs
  Cire has not made yet would go. Each becomes a real screen only when that
  design exists.

## Tests

- **The page, end to end:** `tools/e2e/tests/flows/cire-landing-home.flow.ts`
  (`bun run test:e2e -- --grep cire-landing-home`). It checks the section order,
  that no copy carries an em-dash or "premium", that every in-page link lands
  and every organiser link is the portal (or the claim link), the claim field's
  preview and link, the chips by mouse and arrow keys, the demo sending nothing,
  the journey tabs, the plans' prices and caps, the page with JavaScript off
  and under reduced motion, and the layout at 390 and 768 px. It never follows a
  link into the portal, whose API calls would make `results.json` differ
  between runs. Screenshots land in `e2e-artifacts/screenshots/cire-landing-home/`.
- **The `repo` project.** `tests/lib/plans.test.ts`, `tests/lib/slug-preview.test.ts`
  and `tests/styles/design-token-contract.test.ts` read files in other packages.
  They run as the vitest `repo` project (`test:repo`), which
  `cire/landing/turbo.json` reruns when those files change; `test` runs the rest
  ([[testing-patterns#Tests that read files outside their package]]).
  `test:run` runs both.
- **To look at it**, run `CLAUDECODE= bun run dev:cire-landing` (or
  `PORT=<port> bun run --cwd cire/landing dev:app` beside a running E2E stack,
  which holds 4323). `dev:landing` is `@musubi/landing`, a different site.

## Related

- [[cire]] — the wedding-invite stack the landing page markets
- [[cire-auth]] — guest vs organiser auth (the two CTAs' destinations)
- [[production-deploy]] — secrets/vars + the cutover steps
- [[free-tier-limits]] — Cloudflare Free-tier ceilings the stack runs under
