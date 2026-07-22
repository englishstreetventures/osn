# Invite design selector — design spec

Date: 2026-07-22
Status: approved (sections 1–3); new-design build deferred to a later spec

## Goal

Let a wedding's invite render as one of several full template packs — own layout
structure, section order, motion, and typography defaults — while all invite data
stays the same. The invite link does not change; the server resolves which design
to show. Guests must not pay any performance cost for designs they never see.

## Decisions (locked with user)

1. **Depth**: full template packs. Per-wedding theming (colors, fonts, images) still
   applies on top of whichever design is active.
2. **Resolution**: design id stored in the DB on the wedding's customisation row.
   `/<slug>` SSR fetch already resolves the wedding, so the design rides along —
   zero extra round-trip. Links stay stable; switching design updates all sent links.
3. **Gating**: entitlement gate built now against the reserved `premium_templates`
   entitlement; every design in the launch catalog is `free`, so the gate is dormant
   but tested.
4. **Catalog at launch**: current layout becomes `classic` and is the default.
   The first new design will arrive via a separate spec from the user; this work
   ships the selector architecture with `classic` only.
5. **Architecture**: design registry + per-design component trees (not a
   config-driven layout engine). Each design is a folder of components; a registry
   map keys them by design id.

## 1. Data model, catalog, API

### Schema

- Migration: `wedding_invite_customisations` gains
  `design_id TEXT NOT NULL DEFAULT 'classic'`. Additive with default — existing
  rows and prod migration are safe; no backfill needed.
- Drizzle schema (`cire/db/src/schema.ts`) updated to match.

### Shared catalog package

- New small package `@shared/invite-designs` (same pattern as
  `@shared/feature-flags`), the single source of truth:
  - `DESIGNS: readonly DesignMeta[]` — `{ id, name, tier: "free" | "premium" }`.
  - `DesignId` union type derived from the catalog.
  - `isDesignId(value): value is DesignId` guard.
- Launch catalog: `[{ id: "classic", name: "Classic", tier: "free" }]`.
- Consumers: `@cire/api` (validation + entitlement tier), `@cire/organiser`
  (selector UI), `@cire/web` (registry keys type-checked against `DesignId`).

### API

- Public `GET /api/invite/:slug` response gains `designId: DesignId`. No new
  endpoint, no extra fetch; `Cache-Control: no-store` unchanged.
- Organiser `GET /api/organiser/weddings/:weddingId/invite` includes `designId`.
- New `PUT /api/organiser/weddings/:weddingId/invite/design` (role
  `weddingEditor`), body `{ designId: string }`:
  - unknown id → 422;
  - catalog tier `premium` without
    `entitlementService.has(weddingId, "premium_templates")` → 403;
  - otherwise persist and return the updated customisation.

## 2. Guest rendering + performance

### Layout

```
cire/web/src/designs/
  registry.ts        // Record<DesignId, DesignEntry>
  types.ts           // InviteDesignProps — the data contract every design accepts
  classic/
    Document.astro   // moved from components/InviteDocument.astro
    InviteHeader.tsx
    InvitePage.tsx
    UnlockReveal.motion.ts
```

- Truly shared pieces stay in `cire/web/src/components/` and are composed by
  designs: `LoginSection`, `RsvpModal`, `DetailsModal`, `EventCard`,
  `PulseAccountLink`, claim types, `invite-theme.ts`.
- `InviteDesignProps` carries the same data every design receives: slug plus the
  invite customisation payload. Claim flow and `ClaimResult` are design-agnostic.
- `[slug].astro` renders `registry[designId]`, where `designId` comes from the
  invite fetch. Any unknown or missing id falls back to `classic` — never a 500.

### Performance posture

- Design resolution is server-side inside the existing SSR fetch: no second
  request, no client-side design switch, no layout flash.
- Astro ships only the islands the rendered tree references, so per-design JS
  bundles come free from the registry structure. Post-claim motion stays a
  dynamic import (current `UnlockReveal.motion` pattern).
- Each design's `Document.astro` declares its own font preloads and hero image
  preload. A guest never downloads another design's fonts or scripts.
- Claim flow, rate limiting, Turnstile gate, image pipeline, and cache headers
  are untouched.

## 3. Organiser selector + gating

- `InviteBuilder.tsx` gains a "Design" section: one card per catalog entry —
  name, static thumbnail, and a lock badge on premium designs the wedding is not
  entitled to. Selecting a card calls `PUT /invite/design`.
- Preview strategy: the builder's inline WYSIWYG preview
  (`invite-theme-preview.ts`) stays classic-shaped. Other designs get a static
  thumbnail plus a "preview live" link that opens the real guest site under the
  existing host-preview session (`preview: true`). No per-design preview engine.
- Theming controls keep working on top of any design; a design supplies its own
  typography defaults, and organiser overrides win.
- Client hides nothing it shouldn't: locked designs render disabled with the
  badge, and the server validates the entitlement regardless.

## 4. Testing + rollout

- API tests: unknown design id → 422; premium id without entitlement → 403
  (seed a temporary premium fixture entry for the test); happy path persists and
  is returned by both GET routes.
- Web tests: registry falls back to `classic` on unknown id; classic renders
  against the same fixture payload it does today.
- Schema change lives in the shared `@cire/db` package → run the full monorepo
  suite before merge, not just cire packages.
- Rollout: default `classic` means zero visual change for existing weddings.
  Open the PR early for the `*.pages.dev` preview. Prod D1 migration is an
  additive column with a default.

## Out of scope (deferred)

- The first new design (working id `gala`): layout, motion, and visual direction
  arrive via a user-supplied spec; adding it will be a new folder under
  `designs/`, one catalog entry, and one thumbnail.
- Premium purchase flow (Lemon Squeezy) — gate exists, tiers flip later.
- Per-family/guest design variation.
- Edge caching of the invite payload (stays `no-store`).
