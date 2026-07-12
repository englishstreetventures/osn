---
title: "Cire TODO — wedding-management platform"
tags: [todo, platform]
related:
  - "[[index]]"
  - "[[platform-plan]]"
  - "[[future]]"
last-reviewed: 2026-07-10
---

# Platform

Build-out of the organiser portal into a full wedding management platform. Architecture, schema sketches, and rationale in [[platform-plan]] — this shard is the actionable checklist. Phases land in order; P1 and the vendor-CRM half of P2 are parallelisable after P0.

**Picking up a phase in a fresh session?** Read [[platform-plan]] §12 (Agent pick-up guide) first — code map, invariants, per-PR definition of done, and per-phase entry points.

## Phase 0 — core-domain refactor (invite decoupling)

PR slicing + dependency order in [[platform-plan]] §3.6 (PRs 0–2 parallel; IA shell lands **early** so CRUD is built into its module home).

- [x] **PR 0 — T-S1 lockstep test** — `cire/api/src/db/ddl-lockstep.test.ts` replays the full migration chain (filename order, as `wrangler d1 migrations apply` does) against the `setup.ts` DDL **and** the Drizzle schema (`getTableConfig`) via a normalised structural snapshot diff. Fixed four setup.ts drifts it surfaced (events `DEFAULT ''`s, missing `guest_events_event_id_idx`, stale guests index, invented rsvps CHECK) and deleted the `schema.test.ts` mini-mirror (now runs on `createDb()`). The `families` rebuild (PR 4) is unblocked.
- [x] **PR 1 — Wedding profile + event locations** — migration `0030` adds `wedding_date`, `guest_count_estimate`, `currency` (NOT NULL DEFAULT `'AUD'`), `budget_total_minor` to `weddings` and `location_lat`/`location_lng` + `pricing_region` to `events` (all three DDL surfaces). **Location is EVENT-scoped** (decided 2026-07-10, see [[deferred]]): a wedding can span countries, so each event carries its own point + region (venue text stays in `events.address`) while the wedding keeps ONE main currency. New Settings tab (visible to co-hosts read-only; save owner-only): `GET/PUT .../settings` (PUT with PATCH semantics — the CORS method list has no PATCH). Per-event location editor on the Events tab (`EventLocationsPanel`): `PUT .../events/:eventId/location` — member-level, like the import. `POST .../settings/geocode` (member-level, per-IP limiter): **key-optional Geocoding** (`GOOGLE_GEOCODING_API_KEY` secret; no key or upstream failure ⇒ `unavailable` ⇒ manual lat/lng fallback — fail-soft, nothing sent to Google). `pricing_region` = closed **state-granular** enum in `lib/pricing-regions.ts` (v1; metro splits deferred to Phase 3 dataset work), derived server-side from the geocoded state/country. Subprocessor + data-map rows added. Metrics `cire.wedding.settings.saved`, `cire.event.location.saved`, `cire.geocode.requests`.
- [ ] **PR 2 — Roles** — `wedding_hosts.role` `editor`/`viewer` + `weddingEditor()` gate; data `UPDATE 'host' → 'editor'` (no CHECK constraint, no rebuild); closes the root-TODO co-host-roles item
- [ ] **PR 3 — Portal IA shell** — module sidebar + Overview home (countdown, RSVP totals, task/budget snapshots); extend `dashboard-route.ts` to `#/w/:weddingId/:module/:sub`; `GettingStarted` becomes Overview empty-state; fold in the P-I3 fetch-lifting fix
- [ ] **PR 4 — Households ≠ claim codes** — `families.publicId` nullable via `__keep_*` table rebuild + partial unique index; households creatable without a code; "issue invite" (single + bulk via existing re-mint) from the Invite module; **import keeps auto-minting** (decided); deactivation stays invite-only
- [ ] **PR 5a — Guest + household + event CRUD** — organiser create/edit/delete for households, guests, events; per-guest attendance editing with **state-loss confirm** when un-inviting over an existing RSVP; **`source: 'import'|'manual'` provenance** on families/guests, import diff manages import-sourced rows only by default
- [ ] **PR 5b — Organiser-recorded RSVPs** — `PUT .../guests/:guestId/rsvps/:eventId`; `consent_source` (`guest`/`organiser_attested`) + writer recorded (compliance delta, [[platform-plan]] §10)
- [ ] **Module routers** (with PR 3/5) — reorganise `/api/organiser/weddings/:weddingId/*` into `guests|schedule|invite|…|settings` factories; **one-release alias layer** at the old prefixes (decided), delete next release

## Phase 1 — planning core

- [ ] **Service-category enum** — closed shared enum in `cire/api/src/lib/service-categories.ts` (vendors + budget + tasks + pricing + metrics)
- [ ] **Checklist** — `tasks` table; versioned lead-time template seeded from `wedding_date`; re-anchor incomplete seeded tasks on date change; day-of tasks link to events (run-sheet view)
- [ ] **Budget v1** — `budget_items` + `payments` tables (minor units, **single currency: the wedding's main `currency`** — organiser converts foreign quotes on entry; weddings span countries but the budget is counted in the one currency the couple thinks in, see [[platform-plan]] §4.2 multi-currency note); per-category rollup vs total; upcoming-payments feed to Overview. Optional additive v2 (display-only `original_currency`/`original_amount_minor` on items/payments) is a [[deferred]] decision — don't build speculatively
- [ ] **Overview widgets** — RSVP totals, open tasks by bucket, budget summary, payment nudges

## Phase 2 — vendors & services

- [ ] **Vendor CRM (wedding-scoped)** — `vendors` table + status board UI (researching → booked); category filter; `available_on_date` recorded fact; booking creates/links a budget item + ticks matching tasks
- [ ] **Venue link** — `events.venue_vendor_id` so a booked venue attaches to a Schedule event
- [ ] **Directory schema** — global `directory_vendors` + `wedding_vendor_links` (shortlist) + "import to CRM"
- [ ] **Directory search** — lat/lng bounding-box prefilter + haversine order on D1, radius from the wedding's canonical point; dedicated rate limiter
- [ ] **Availability** — `vendor_availability` per-day status; "available on your date" badge in search (badge, not filter-out)
- [ ] **Vendor self-serve** — OSN-account sign-in (`osnAuth()` + listing-ownership authz); listing editor + availability calendar; moderation/`suspended` state before opening claims
- [ ] **Enquiries** — `vendor_enquiries` + messages; quotes feed `budget_items.quoted_minor`; spam limiter
- [ ] **Compliance** — data-map + retention rows for vendor contact PII and enquiry content

## Phase 3 — pricing estimates

- [ ] **Heuristic engine v1** — pure `services/pricing.ts` over versioned `lib/pricing-baselines.ts` (category × region × per-head/flat ranges, season + weekend multipliers); `GET .../budget/estimates` with provenance strings; Budget seeds from it
- [ ] **Directory-informed v2** — blend median quoted amounts by category within radius; k-anonymity floor (~5) before any aggregate is shown

## Phase 4 — seating, comms, registry

- [ ] **Seating** — `seating_tables` + `seating_assignments` per event; drag-drop island; declined/no-response badges; CSV/print export
- [ ] **Guest emails** — new columns + consent design (collection point decision in [[deferred]]); data-map/retention/DPIA delta
- [ ] **Comms** — save-the-date / invite-live / RSVP-chaser emails via `@shared/email`; key-optional fail-soft (prod email currently degraded); comms log + suppression list
- [ ] **Registry** — first candidate after Phase 2 (root-TODO "withjoy parity"); wishing-well payments stay deferred
