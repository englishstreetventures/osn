---
title: "Cire TODO — organiser spreadsheet import"
tags: [todo, organiser, spreadsheet]
related:
  - "[[index]]"
  - "[[api]]"
  - "[[db]]"
last-reviewed: 2026-05-05
---

# Organiser Spreadsheet Import

Source spreadsheet has these columns: `Family ID, Guest First Name, Guest Last Name, Family Name, Catholic Wedding, Hindu Wedding, Reception, Mehndi`. Row grouping is by `Family Name`; only the last row of each family carries a Family ID in the source sheet (we ignore that — Cire generates its own `publicId`). Each guest row has booleans per event.

## Spreadsheet ingestion (apps/api)

- [x] `services/spreadsheet.ts` — `parseEventsCsv` / `parseGuestsCsv` (hand-rolled RFC 4180); rejects formula-injection cells (cells starting with `=`, `+`, `-`, `@`) (PR-C; trim-resilient as of PR-C review)
- [x] `services/import.ts` — `diffAgainstDb(parsed)` returns `ImportPlan` (creates / updates / removes per family + per guest); `applyImport(plan)` executes in dependency order with per-statement chunking (PR-C)
- [x] `services/r2-imports.ts` — R2Service Context tag + `storeUpload` / `fetchUpload` (PR-C)
- [x] `services/revert.ts` — `revertImport` re-fetches prior CSVs from R2, re-parses, re-diffs, re-applies (PR-C)
- [x] `schemas/import.ts` — Effect Schema for `ParsedEvent`, `ParsedFamily`, `ImportPlan`, request/response shapes (PR-C)
- [x] Plan preserves `publicId` for matched families (case+whitespace-insensitive on `family_name`); only mints new IDs for brand-new families (PR-C)
- [x] Per-guest event invitations from boolean columns drive `guestEvents` rows (PR-C)
- [ ] When the source sheet adds a stable `Guest ID` column, populate `guests.externalId` from it (already in schema as of PR-A)

## Organiser portal (apps/web + apps/api)

- [ ] Organiser auth model (passkey + magic link, separate `organisers` table)
- [ ] Auth middleware that rejects guest sessions on organiser endpoints
- [ ] `/organiser/import` page — paste / upload, preview diff table, confirm
- [ ] Extend `OrganiserView` to display family-grouped guests with shareable publicId + password (show password only at family creation, hash thereafter — surface a "regenerate password" action)

## Cloudflare wiring

- [ ] Replace `bun:sqlite` runtime in `apps/api/src/index.ts` with `drizzle(env.DB)` on D1
- [ ] `bunx wrangler d1 migrations apply cire-db --local` in dev script
- [ ] `bunx wrangler types` after binding changes
- [ ] **Provision R2 bucket `cire-sheets` (and `cire-sheets-preview`) before first deploy** — `bunx wrangler r2 bucket create cire-sheets`. Binding `SHEETS` is already declared in `apps/api/wrangler.toml` as of PR-A.
- [ ] Batch import respects 50ms CPU / 30s wall-time Worker limits — chunk inserts to ~100 rows; consider Durable Objects or Queues for guest lists ≥ ~500 families
