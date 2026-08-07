---
title: "Invite design selector"
tags: [systems, web, api]
related:
  - "[[index]]"
  - "[[invite-builder]]"
last-reviewed: 2026-08-07
---

# Invite design selector

A wedding's invite renders as one of several full template packs. The design id
lives on `wedding_invite_customisations.design_id` (0045, default `classic`);
the guest `[slug].astro` SSR fetch resolves it — same link, zero extra
round-trips.

## Pieces

- **Catalog** — `@cire/invite-designs`: `DESIGNS` (`{ id, name, tier }`),
  `DesignId` union, `isDesignId`, `DEFAULT_DESIGN_ID`. Single source of truth
  for api validation, the organiser selector, and the web registry keys.
- **API** — both invite GETs surface `designId`;
  `PUT /api/organiser/weddings/:weddingId/invite/design` (weddingEditor)
  validates against the catalog (unknown → 422) and gates `premium` tiers on
  the `premium_templates` entitlement (403). `inviteService.setDesign` bumps
  `updatedAt` only — never `imagesUpdatedAt` (WT-P-I1).
- **Web** — `cire/invites/src/designs/`: `registry.ts` maps `DesignId` →
  per-design component tree (`classic/` holds the original layout);
  `resolve.ts` (`resolveDesignId`) falls back to classic on unknown ids so a
  guest invite never 500s. Registry imports `.astro`, so vitest tests target
  `resolve.ts` only. Truly shared pieces (LoginSection, RsvpModal,
  DetailsModal, EventCard, PulseAccountLink, invite-theme, invite-images) stay
  in `components/`.
- **Organiser** — Design section in `InviteBuilder`; card per catalog entry,
  lock badge on unentitled premium designs, instant save. **The live previews
  follow the pack** (2026-08-06): `invite/design-layout.ts` names each pack's
  structural signature and `HeroSample`/`SectionSample` render it, so switching
  designs visibly re-shapes the miniature. See [[invite-builder]] §preview.

## Adding a design

1. Catalog entry in `@cire/invite-designs` (type error in the web registry
   until step 2 lands).
2. New pack folder `cire/invites/src/designs/<id>/` + registry entry. Each pack's
   `Document.astro` owns its font preloads and islands, so guests never
   download another design's assets.
3. Row in `cire/host/src/components/invite/design-layout.ts` describing how
   the pack is SHAPED, so the builder's preview stops previewing it as Classic.
   Not optional — `design-layout.test.ts` asserts every catalog id has its own
   entry, so step 1 without this fails the organiser suite.
4. Tier `premium` → gate already enforced; no api change.

## Testing seams

- `AppOptions.inviteDesigns` / `createInviteOrganiserRoutes` 5th param inject
  a test catalog (the launch catalog is all-free, so premium-gate tests add a
  fixture design).
