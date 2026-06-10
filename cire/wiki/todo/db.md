---
title: "Cire TODO — cire/db"
tags: [todo, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-06-10
---

# cire/db

Schema and migration work. See [[monorepo-structure]] for how this package fits into the dependency graph.

- [x] Events: `startAt`, `endAt`, `timezone`, `address`, `dressCodeDescription`, `dressCodePalette`, `pinterestUrl`, `mapsUrl`, `sortOrder` (PR-A)
- [x] `imports` table for spreadsheet-upload tracking with R2 keys + status lifecycle (PR-A)
- [x] `guests.externalId` nullable column for forward-looking spreadsheet stable IDs (PR-A)
- [x] ~~Add `organisers` + `organiser_sessions` tables once auth lands~~ — **Obsolete**: organiser auth reuses OSN passkeys (stateless JWT verification, no cire-side organiser tables); ownership lives on `weddings.owner_osn_profile_id`. See `[[wiki/systems/cire-auth]]` in the root OSN wiki.
- [x] Multi-tenant scaffold (OSN merge) — `weddings` root table; `families`/`events`/`imports` carry `wedding_id` NOT NULL FK cascade; migration `0006_multi_tenant.sql` uses the `__keep_*` snapshot/restore idiom because DROP TABLE under enforced FKs fires ON DELETE CASCADE into children on D1 (pragma can't be disabled) — verified empirically
- [ ] **Substitute the `0006_multi_tenant.sql` bootstrap owner `usr_REPLACE_BEFORE_PROD`** (`wed_bootstrap` row) with the real OSN profile id **before** the migration is applied to remote/production D1
- [ ] Multi-owner weddings — replace `weddings.owner_osn_profile_id` with a `wedding_owners(wedding_id, osn_profile_id, role owner/editor/viewer)` join table (also tracked in root `wiki/TODO.md` Cire section)
- [x] Add `dietary_requirements` column to rsvps (added as `dietary` text NOT NULL DEFAULT '' in migration `0002_add_rsvp_dietary.sql`; per-event dietary lives on `rsvps` row)
- [ ] Retire deprecated `events.date` / `events.location` columns (kept in 0003 for backwards compatibility — D1 is forward-only so this needs a separate copy-and-drop migration)
- [ ] Seed script for local development that exercises real `generatePublicId` / `generatePassword` (currently uses fixed JSON fixtures so tests stay deterministic)
- [x] `db:push` / `db:seed` / `db:reset` / `db:generate` / `db:studio` scripts in `cire/db/package.json`; `seed/dev-seed.sql` mirrors `cire/api/src/data/*` for local D1 — see `cire/db/README.md`
- [ ] DRY the dev seed — move `cire/api/src/data/{events,guests}.json` into `cire/db/seed/data/` (or a TS module) and have `cire/api/src/db/setup.ts` import from there, so `seed/dev-seed.sql` regenerates from a single source rather than being hand-mirrored
