---
title: Cire Landing
description: Static marketing site for the Cire wedding platform
tags: [app, weddings, marketing]
status: active
packages:
  - "@cire/landing"
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[production-deploy]]"
  - "[[dev-environment]]"
last-reviewed: 2026-10-09
---

# Cire Landing

`@cire/landing` is the static Astro marketing site at `cireweddings.com`. It introduces the wedding platform through the invitation, guest replies and organiser tools. The guest invitation (`@cire/invites`) and organiser portal (`@cire/host`) remain separate applications; see [[cire]] and [[cire-auth]].

## Page narrative

The page retains Cire's forest-green and gold identity, Cormorant Garamond display type and Lato body type. The sections in `src/pages/index.astro` are:

1. Hero: “Your wedding. Beautifully together.”, with actual invitation and organiser previews.
2. Invitations: Classic and Gala, both included with Ivory.
3. Guest replies: household codes, per-person and per-event attendance, and the interactive RSVP demonstration.
4. Planning: overview, budget, checklist, registry and vendor tools, with their tier requirements.
5. Getting started: create a wedding, personalise it, then share and organise.
6. Pricing: three named plans and the Gold-to-Crimson upgrade.
7. FAQ, final invitation to start, and legal links.

The navigation links directly to invitations, planning and pricing. Every primary action opens the organiser portal. Paid-plan actions say to start free and choose the plan; they do not imply checkout happens on the marketing page. Testimonials stay hidden until permissioned quotes exist.

## Plans

`src/lib/plans.ts` holds the owner-approved public AUD offer:

| Plan | One-time price per wedding | Guests | Includes |
|---|---|---|---|
| Ivory | Free | 100 | Classic and Gala invitations, events, guest list, RSVPs, import and co-hosts |
| Gold | A$79 | 500 | Ivory plus budget, payment tracking, checklist and registry |
| Crimson | A$149 | 1,000 | Gold plus vendor tools, directory and enquiries |

Gold to Crimson costs A$70. The plan test compares advertised guest ceilings with `cire/api/src/services/tiers.ts`. Pricing changes must also be checked against organiser checkout configuration. Terms list the same module boundaries; their legal draft gate remains in place.

## Product imagery

`public/images/` contains first-party WebP captures of actual invitation and organiser components with synthetic example data. They depict the product, rather than customer testimonials or real wedding records. `public/images/README.md` records the photography sources and capture provenance. `cire-social.jpg` is the social sharing image. Product previews have explicit dimensions, below-fold captures load lazily, and stable image filenames have a bounded cache lifetime.

## Interaction and accessibility

The RSVP island uses `client:visible`. A valid response shows an explicit preview confirmation and makes no API request; the existing demo tests assert no fetch. FAQ disclosures use native `details` and work without JavaScript. Content is visible by default; reveal effects are added only when JavaScript runs and reduced motion is not requested. A skip link targets the main content. The page renders without the procedural vine or WebGL seal backdrop.

## Configuration and deployment

- `PUBLIC_ORGANISER_URL`: destination for start actions.
- `PUBLIC_DEMO_INVITE_URL`: optional external invitation; when unset, the invitation action scrolls to the in-page example.
- `SITE`: canonical origin for metadata and social-image URLs.

Fonts are downloaded and self-hosted by Astro during the build. The build's font guard rejects an artefact without emitted fonts; network access to the configured provider is therefore required. The bundle-size guard runs after the font check.

The development site is `dev.cireweddings.com`; production is `cireweddings.com`. CI deploys the development tier on merge and production requires approval of the production GitHub Environment. See [[dev-environment]] and [[production-deploy]]. Local server addresses and branch-prefixed hosts follow [[devloop-urls]].
