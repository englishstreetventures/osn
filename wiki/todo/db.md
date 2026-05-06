---
title: "Cire TODO — packages/db"
tags: [todo, db]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
last-reviewed: 2026-05-05
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
