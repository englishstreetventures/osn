---
title: "Cire TODO — wedding-management platform"
tags: [todo, platform]
related:
  - "[[index]]"
  - "[[platform-plan]]"
  - "[[future]]"
last-reviewed: 2026-07-08
---

# Platform

Build-out of the organiser portal into a full wedding management platform. Architecture, schema sketches, and rationale in [[platform-plan]] — this shard is the actionable checklist. Phases land in order; P1 and the vendor-CRM half of P2 are parallelisable after P0.

**Picking up a phase in a fresh session?** Read [[platform-plan]] §12 (Agent pick-up guide) first — code map, invariants, per-PR definition of done, and per-phase entry points.

## Phase 0 — core-domain refactor (invite decoupling)

PR slicing + dependency order in [[platform-plan]] §3.6 (PRs 0–2 parallel; IA shell lands **early** so CRUD is built into its module home).

- [ ] **PR 0 — T-S1 lockstep test** — migration/DDL mirror test **before** the `families` rebuild lands (the rebuild is the riskiest artifact — `__keep_*` snapshot/restore idiom under D1's enforced cascades)
- [ ] **PR 1 — Wedding profile** — add `wedding_date`, `location_name`, `location_lat`/`location_lng`, `pricing_region`, `guest_count_estimate`, `currency`, `budget_total_minor` to `weddings`; Settings view with **key-optional Geocoding API** (no key ⇒ manual lat/lng fallback); `pricing_region` from geocoded locality via checked-in mapping; subprocessor + data-map rows
- [ ] **PR 2 — Roles** — `wedding_hosts.role` `editor`/`viewer` + `weddingEditor()` gate; data `UPDATE 'host' → 'editor'` (no CHECK constraint, no rebuild); closes the root-TODO co-host-roles item
- [ ] **PR 3 — Portal IA shell** — module sidebar + Overview home (countdown, RSVP totals, task/budget snapshots); extend `dashboard-route.ts` to `#/w/:weddingId/:module/:sub`; `GettingStarted` becomes Overview empty-state; fold in the P-I3 fetch-lifting fix
- [ ] **PR 4 — Households ≠ claim codes** — `families.publicId` nullable via `__keep_*` table rebuild + partial unique index; households creatable without a code; "issue invite" (single + bulk via existing re-mint) from the Invite module; **import keeps auto-minting** (decided); deactivation stays invite-only
- [ ] **PR 5a — Guest + household + event CRUD** — organiser create/edit/delete for households, guests, events; per-guest attendance editing with **state-loss confirm** when un-inviting over an existing RSVP; **`source: 'import'|'manual'` provenance** on families/guests, import diff manages import-sourced rows only by default
- [ ] **PR 5b — Organiser-recorded RSVPs** — `PUT .../guests/:guestId/rsvps/:eventId`; `consent_source` (`guest`/`organiser_attested`) + writer recorded (compliance delta, [[platform-plan]] §10)
- [ ] **Module routers** (with PR 3/5) — reorganise `/api/organiser/weddings/:weddingId/*` into `guests|schedule|invite|…|settings` factories; **one-release alias layer** at the old prefixes (decided), delete next release

## Phase 1 — planning core

- [ ] **Service-category enum** — closed shared enum in `cire/api/src/lib/service-categories.ts` (vendors + budget + tasks + pricing + metrics)
- [ ] **Checklist** — `tasks` table; versioned lead-time template seeded from `wedding_date`; re-anchor incomplete seeded tasks on date change; day-of tasks link to events (run-sheet view)
- [ ] **Budget v1** — `budget_items` + `payments` tables (minor units, wedding currency); per-category rollup vs total; upcoming-payments feed to Overview
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
