---
title: "Cire TODO — cire/db"
tags: [todo, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
  - "[[invite-builder]]"
last-reviewed: 2026-06-16
---

# cire/db

Schema and migration work. See [[monorepo-structure]] for how this package fits into the dependency graph.

- [x] **`families.kind` column** (migration `0010_family_kind.sql`) — `'guest' | 'host'`, default `'guest'`. Marks the synthetic per-wedding "host preview" family whose `HOST-*` code lets the organiser see every event (the "Preview invite" button). Partial unique index `families_one_host_per_wedding` (`wedding_id WHERE kind = 'host'`) caps it at one host family per wedding. Additive + self-backfilling (existing rows default to `guest`). LOCKSTEP mirrors updated in `cire/api/src/db/setup.ts` + `db/schema.test.ts`. See `[[wiki/systems/cire-auth]]` (root, Host preview code).
- [x] **`wedding_invite_customisations` table** (migration `0009_invite_customisations.sql`) — per-wedding invite-builder presentation overrides. `wedding_id` PK + cascade FK (1:1). Nullable text slots (`hero_title`, `hero_subtitle`, `story_eyebrow`, `story_heading`, `story_body`) + nullable R2 image keys (`hero_image_key`, `story_image_key`); null ⇒ built-in default. LOCKSTEP mirror updated in `cire/api/src/db/setup.ts`. See `[[invite-builder]]`. ⚠️ Image rows reference photos (personal data) — folds into the existing cire retention gap.
- [x] **`guest_account_links` table** (migration `0008_guest_account_links.sql`) — optional per-invitee link to an OSN account. Columns: `guest_id`/`family_id`/`wedding_id` (all cascade FKs), `osn_account_id` + `osn_profile_id` (opaque cross-DB refs, no FK), `linked_at`/`updated_at`. Unique on `guest_id` (one link per invitee) and `(family_id, osn_account_id)` (no double-seating); indexed on `osn_account_id` (reverse lookup) and `family_id`. LOCKSTEP mirrors updated in `cire/api/src/db/setup.ts` + `db/schema.test.ts`. See `[[wiki/systems/cire-auth]]` (root).
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
