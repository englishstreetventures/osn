---
title: "Cire TODO — packages/db"
tags: [todo, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-05-07
---

# packages/db

Schema and migration work. See [[monorepo-structure]] for how this package fits into the dependency graph.

- [x] Events: `startAt`, `endAt`, `timezone`, `address`, `dressCodeDescription`, `dressCodePalette`, `pinterestUrl`, `mapsUrl`, `sortOrder` (PR-A)
- [x] `imports` table for spreadsheet-upload tracking with R2 keys + status lifecycle (PR-A)
- [x] `guests.externalId` nullable column for forward-looking spreadsheet stable IDs (PR-A)
- [ ] Add `organisers` + `organiser_sessions` tables once auth lands
- [x] Add `dietary_requirements` column to rsvps (added as `dietary` text NOT NULL DEFAULT '' in migration `0002_add_rsvp_dietary.sql`; per-event dietary lives on `rsvps` row)
- [ ] Retire deprecated `events.date` / `events.location` columns (kept in 0003 for backwards compatibility — D1 is forward-only so this needs a separate copy-and-drop migration)
- [ ] Seed script for local development that exercises real `generatePublicId` / `generatePassword` (currently uses fixed JSON fixtures so tests stay deterministic)
- [x] `db:push` / `db:seed` / `db:reset` / `db:generate` / `db:studio` scripts in `packages/db/package.json` (root aliases too); `seed/dev-seed.sql` mirrors `apps/api/src/data/*` for local D1 — see `packages/db/README.md`
- [ ] DRY the dev seed — move `apps/api/src/data/{events,guests}.json` into `packages/db/seed/data/` (or a TS module) and have `apps/api/src/db/setup.ts` import from there, so `seed/dev-seed.sql` regenerates from a single source rather than being hand-mirrored
