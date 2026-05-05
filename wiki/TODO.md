---
title: "Cire TODO"
tags: [todo, progress]
related:
  - "[[index]]"
  - "[[monorepo-structure]]"
  - "[[overview]]"
  - "[[contributing]]"
last-reviewed: 2026-05-05
---

# Cire TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Current Status

Monorepo built and functional. `packages/db` models families with a shareable `publicId` (e.g. `PATEL-JOY-RK97`) and per-family guests; `apps/api` exposes `POST /api/claim` (publicId-only auth), `POST /api/rsvp` (per-person per-event with dietary), `GET /api/organiser/guests`, plus rate-limit middleware on `/api/claim`. Organiser portal split into its own Astro app (`apps/organiser`) with `GuestTable` consuming the new shape. Backend is Effect-based with Effect Schema validation; tests co-located `*.test.ts` under `bun test`. Migrations: `0001_initial.sql`, `0002_add_rsvp_dietary.sql`. Next slice: spreadsheet upload that drives reconciliation against this schema, plus wiring the guest-app RSVP modal to the live endpoint.

---

## Up Next

- [ ] Spreadsheet parser — accept CSV/TSV paste or .xlsx, group rows by `Family Name`, build canonical `ParsedFamily[]`
- [ ] Diff + batched upsert service — empty-DB insert path and incremental reconciliation
- [ ] Organiser auth — separate from guest claim flow (passkey + magic link)
- [ ] `POST /api/organiser/import/{preview,apply}` endpoints
- [ ] Organiser portal upload UI (paste sheet / upload .xlsx, preview diff, confirm)
- [ ] Migrate runtime DB layer in `apps/api/src/index.ts` from 503 stub to real D1
- [x] Per-person per-event RSVP with dietary requirements
- [x] Rate-limit claim attempts to prevent brute force — see [[overview]] for logging rules
- [ ] Wire guest-app RSVP modal to `POST /api/rsvp`
- [ ] Add-to-calendar links on event cards (Google / Apple / .ics)

---

## Organiser Spreadsheet Import

Source spreadsheet has these columns: `Family ID, Guest First Name, Guest Last Name, Family Name, Catholic Wedding, Hindu Wedding, Reception, Mehndi`. Row grouping is by `Family Name`; only the last row of each family carries a Family ID in the source sheet (we ignore that — Cire generates its own `publicId`). Each guest row has booleans per event.

### Spreadsheet ingestion (apps/api)

- [ ] `services/spreadsheet.ts` — `parseTsv` / `parseCsv` / `parseXlsx`; reject formula-injection cells (cells starting with `=`, `+`, `-`, `@`) — see [[overview]] for logging guidance
- [ ] `services/import.ts` — `diffAgainstDb(parsed)` returns `ImportPlan` (creates / updates / removes per family + per guest); `applyImport(plan)` executes in batched D1 transactions
- [ ] `schemas/import.ts` — Effect Schema for the parsed row shape and the import response
- [ ] Plan should preserve generated `publicId` + password for existing families; only assign new ones to brand-new families
- [ ] Per-guest event invitations from boolean columns drive `guestEvents` rows

### Organiser portal (apps/web + apps/api)

- [ ] Organiser auth model (passkey + magic link, separate `organisers` table)
- [ ] Auth middleware that rejects guest sessions on organiser endpoints
- [ ] `/organiser/import` page — paste / upload, preview diff table, confirm
- [ ] Extend `OrganiserView` to display family-grouped guests with shareable publicId + password (show password only at family creation, hash thereafter — surface a "regenerate password" action)

### Cloudflare wiring

- [ ] Replace `bun:sqlite` runtime in `apps/api/src/index.ts` with `drizzle(env.DB)` on D1
- [ ] `bunx wrangler d1 migrations apply cire-db --local` in dev script
- [ ] `bunx wrangler types` after binding changes
- [ ] Batch import respects 50ms CPU / 30s wall-time Worker limits — chunk inserts to ~100 rows; consider Durable Objects or Queues for guest lists ≥ ~500 families

---

## apps/web

- [x] Rework `OrganiserView` to consume the new `OrganiserGuestRow` shape — moved to `apps/organiser/src/components/GuestTable.tsx`
- [ ] Replace hero photo placeholder with actual photo
- [ ] Customise monogram with couple's initials
- [ ] Write Our Story content
- [ ] Populate dress code colour palette swatches
- [ ] Embed actual Pinterest board URLs
- [ ] Wire RSVP modal to `POST /api/rsvp`
- [ ] "Open in Maps" button on event cards (Apple Maps / Google Maps)
- [ ] Add-to-calendar links (Google Calendar, Apple Calendar, .ics)
- [ ] Passkey registration + login UI
- [ ] Magic link email fallback UI

---

## apps/api

- [ ] Spreadsheet parser + diff service + import endpoints (see Organiser Spreadsheet Import above)
- [ ] Organiser auth middleware
- [x] `POST /api/rsvp` — per-person per-event RSVP with dietary requirements
- [ ] `GET /api/events` — list events for the wedding
- [ ] Drizzle D1 client wired in `src/index.ts` (currently 503 stub)
- [ ] Auth middleware — validate passkey session or magic link token
- [ ] Passkey (WebAuthn) registration + authentication endpoints
- [ ] Magic link email dispatch (Resend)
- [ ] Admin endpoints — view RSVPs, regenerate passwords, deactivate families

---

## packages/db

See [[monorepo-structure]] for how this package fits into the dependency graph.

- [ ] Add `organisers` + `organiser_sessions` tables once auth lands
- [x] Add `dietary_requirements` column to rsvps (added as `dietary` text NOT NULL DEFAULT '' in migration `0002_add_rsvp_dietary.sql`; per-event dietary lives on `rsvps` row, deferred-decision resolved)
- [ ] Seed script for local development that exercises real `generatePublicId` / `generatePassword` (currently uses fixed JSON fixtures so tests stay deterministic)

---

## Security Backlog

See [[overview]] for observability rules that apply to all security-sensitive code paths. See [[review-findings]] for severity prefix conventions.

**Critical**

- [ ] `GET /api/organiser/guests` is currently unauthenticated and exposes every family's `publicId` — must be gated behind organiser auth (or removed from the deployed app) before any public launch.
- [x] Rate-limit `POST /api/claim` — KV-backed limiter via `apps/api/src/middleware/rate-limit.ts`

**High**

- [ ] Organiser import endpoints must require organiser session — never guest session
- [ ] Spreadsheet parser must reject formula-injection cells (leading `=`, `+`, `-`, `@`)
- [ ] Magic link tokens must be single-use and expire (≤15 min)

**Medium**

- [ ] RSVP endpoint must verify the session owns the family the guest belongs to
- [ ] Invite token in URL (if any) must be opaque (UUID/random) — not a guest or family id
- [ ] On password regeneration, invalidate existing sessions for that family

**Low**

- [ ] Review Cloudflare Worker CSP headers on the web app
- [ ] Confirm all D1 queries go through Drizzle (no raw SQL interpolation anywhere)
- [ ] Expand passphrase wordlist to ≥1024 entries for ≥40 bits of entropy

---

## Performance Backlog

See [[review-findings]] for severity prefix conventions.

- [ ] PBKDF2 100k iterations + dummy-hash-on-miss is ~20-40ms per request on Workers. Pairs with rate limiting (above) before public launch — once that's in place, consider lowering iterations to 25-50k for a wedding-scale threat model.
- [ ] `getAllGuests` paginate / cursor once organiser UI is built — current single-join is fine at 100 guests, problematic past a few thousand
- [ ] Landing page animations must not block LCP — defer Motion One until after first paint
- [ ] Hero photo must be optimised (WebP/AVIF, responsive srcset)
- [ ] Add-to-calendar data should not require a round-trip if event data is already hydrated in the page
- [ ] .ics generation can be client-side to avoid unnecessary Worker invocation
- [ ] Spreadsheet import on Workers: chunk inserts (≤100 rows per batch) to stay under 50ms CPU per request; offload large diffs to a Queue-driven worker

---

## Deferred Decisions

| Question                                  | Options considered                                                                                        | Deadline / trigger                                                  |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Event invitations per-family vs per-guest | Per-guest matches sheet exactly (current schema); per-family simpler but loses fidelity                   | After first import lands and real spreadsheet variation is observed |
| Spreadsheet input format                  | TSV paste only / CSV / .xlsx via SheetJS                                                                  | Before upload UI is built                                           |
| Organiser auth model                      | Reuse passkey infra with role flag vs. separate `organisers` table                                        | Before `/api/organiser/import` is hardened                          |
| Surname collision handling in publicId    | Accept multiple `PATEL-*-*` IDs (different word/hash disambiguates) vs. enforce uniqueness on family_name | Stay on current accept-multiple unless aesthetic problem reported   |
| Pinterest embed approach                  | oEmbed API vs. iframe vs. static images                                                                   | Before dress code section is wired up                               |
| Platformise Cire                          | Multi-tenant SaaS vs stay bespoke                                                                         | After friend's wedding ships                                        |
| SMS OTP fallback                          | Twilio/similar vs email-only                                                                              | If magic link proves insufficient                                   |
| Seating planner                           | D1 table arrangement feature                                                                              | Post-MVP                                                            |
| Photo collections                         | Cloudflare R2 + upload UI                                                                                 | Post-MVP                                                            |
| Wishing well                              | Payment processing (requires ABN)                                                                         | After business is set up                                            |
| Guest photo sharing                       | R2 + moderation                                                                                           | Post-MVP                                                            |
| iPhone AirDrop sharing                    | Web Share API + custom payload                                                                            | After core invite is built                                          |

---

## Future

- Apple Wallet pass generation for each event
- Magic link email fallback (Resend)
- D1 migration + wrangler deploy path
- Platformise as multi-tenant wedding invite SaaS
- General wedding planning — guest list management, seating charts
- Physical + digital hybrid: QR codes on printed invites linking to digital counterparts
- Wishing well with payment processing
- Photo collection and guest photo uploads
- iPhone tip-to-tip AirDrop invite sharing
- White-label / custom domain support per wedding
