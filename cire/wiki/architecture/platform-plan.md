---
title: "Platform Plan — from digital invite to wedding management platform"
tags: [architecture, platform, plan]
related:
  - "[[index]]"
  - "[[invite-builder]]"
  - "[[monorepo-structure]]"
  - "[[platform]]"
  - "[[guest-event-editor]]"
last-reviewed: 2026-07-16
pr4-shipped: 2026-07-15
pr4-reversed: 2026-07-15
---

# Platform Plan — from digital invite to wedding management platform

This is the build plan for growing the cire organiser portal (`host.cireweddings.com`) from a digital-invite tool into a full wedding **management** platform: guest list, schedule, vendors (venues / photographers / decorators / caterers / …) with availability and location search, context-aware pricing estimates, budget, checklist, seating, and guest comms — with the digital invite becoming **one module among several** rather than the product itself.

Actionable checklists live in the [[platform]] TODO shard. This page holds the architecture: current-state analysis, target domain model, schema sketches, API/UI shape, phasing rationale, and open decisions.

## 1. Where we are: an invite-first domain

Today every table serves the invite (see `cire/db/src/schema.ts`):

- **`families` is the claim-code unit, not a household record.** `families.publicId` (the claim code) is `NOT NULL UNIQUE` — a household *cannot exist* without an invite credential. `codeSharedAt` / `firstOpenedAt` / `deactivatedAt` are invite-lifecycle fields living on what should be a pure guest-list record. `kind = 'host'` is a synthetic hack to let organisers preview their own invite.
- **Guests exist only via spreadsheet import.** The organiser API is read-only on guests/events (`GET .../guests`, `GET .../events`, CSV exports) plus code management; there is no direct "add a guest" or "create an event" path — the CSV import (`services/import.ts`) is the only writer.
- **`guest_events` is the real schedule-attendance truth** (which guest is expected at which event) but is treated purely as "which events render on this family's invite".
- **`rsvps` is already channel-independent** (keyed `(guestId, eventId)`, unique) — the invite is merely the only *writer* today. This is the one piece that needs no redesign.
- **`wedding_invite_customisations` is a clean presentational overlay** (1:1 with `weddings`, null = defaults) — already correctly separated.
- **`weddings` has no planning context.** No wedding date, no canonical location, no guest-count estimate, no currency/budget. (Events have `startAt`/`address`, but the *wedding* — the thing vendors are booked for and estimates are priced against — has no profile.)
- **Vendors, budget, tasks, timeline, seating: absent.** No tables, routes, services, or components. Greenfield.
- Auth is ready to grow: `weddingOwner()` / `weddingMember()` gates exist, and `wedding_hosts.role` is an enum with only `'host'` today, explicitly reserved for `editor`/`viewer` (root `wiki/TODO.md` co-host-roles item).

The refactor thesis: **promote Guests and Schedule to first-class, invite-independent modules; give the wedding a planning profile; then build the new modules (Vendors, Budget, Checklist, Seating, Comms) against those sources of truth.** RSVP data flows *up* from the invite into the same records the seating chart and caterer head-counts read from.

## 2. Target module map

```
Wedding (profile: date, location, guest estimate, currency, budget)
├── Guests      — households + guests + per-event attendance   (source of truth)
├── Schedule    — events / run-sheet                           (source of truth)
├── Invite      — claim codes, theming, RSVP *channel*         (consumer of Guests + Schedule)
├── Vendors     — CRM → directory, availability, enquiries     (consumer of profile + Schedule)
├── Budget      — categories, estimates → quotes → actuals     (consumer of Vendors + pricing engine)
├── Checklist   — planning tasks by lead time + day-of         (consumer of profile + Schedule)
├── Seating     — tables + assignments per event               (consumer of Guests + RSVPs)
├── Comms       — save-the-dates, reminders, RSVP chasing      (consumer of Guests; needs email)
└── Registry / wishing well / photos                            (later; see [[future]])
```

Modules consume each other through services, never by reaching into another module's tables from a route. Route factories stay one-per-module (existing convention), services stay `Effect.Effect<A, E>` with tagged errors, D1 via Drizzle only.

## 3. Phase 0 — core-domain refactor (invite decoupling)

Everything else builds on this. No new product surface; pure re-foundation.

### 3.1 Wedding profile

Add to `weddings`: `wedding_date` (nullable — engaged couples often don't have one yet), `guest_count_estimate` (nullable int), `currency` (ISO 4217, default `AUD`), `budget_total_minor` (nullable int). New Settings view in the portal (name, slug, profile fields). The profile drives pricing estimates and checklist lead-time seeding. (The originally-planned `location_name` / `location_lat` / `location_lng` / `pricing_region` columns were shipped on `events` by 0030 and then **retired by 0036** — an event's place is its free-text `address`, the sole location source; see the retirement note below.)

**RETIRED (2026-07-16): the separate event location config is gone.** Product-owner decision — the free-text `events.address` already advises the venue and is the SOLE location source the guest site renders (the Maps embed is built from `address` alone; no lat/lng, no geocoding, no map API key). The stored coordinates + pricing region below were a redundant separate config whose only consumers were the UNBUILT Phase 3 planning features, so migration `0036_drop_event_location_config.sql` dropped `location_lat`/`location_lng`/`pricing_region` from `events` and removed the whole write path (the `event-location` route/service, the `settings/geocode` route + Google geocoder + `GOOGLE_GEOCODING_API_KEY`, the `lib/pricing-regions` derivation, `EventLocationsPanel`, and the event-location/geocode metrics). **If Phase 2/3 vendor-radius search or per-region pricing is ever built, geocode `address` on-demand then (YAGNI).** The paragraphs below record the original 0030 design for context only.

~~**Location capture (decided 2026-07-08): key-optional Geocoding API now.**~~ The Settings form geocoded the organiser-typed address to lat/lng + locality server-side (Google Geocoding, same key-optional fail-soft pattern as Maps Embed / Turnstile: no key ⇒ manual lat/lng entry fallback, form still worked). `pricing_region` derived from the geocoded state/locality via a checked-in mapping (`lib/pricing-regions.ts`). All of this was removed by 0036.

~~**Shipped (PR 1, 2026-07-10) — with one revision: location is EVENT-scoped, not wedding-scoped.**~~ A wedding is not a place — its events are (a Sydney reception + Jaipur ceremonies is one wedding in two countries), so `location_lat`/`location_lng` + `pricing_region` landed on `events` (the venue text stays in `events.address`), edited per event on the Events tab (`EventLocationsPanel`, member-level like the import — `PUT .../events/:eventId/location`). **Retired by 0036** — an event's place is now just its free-text `address`. The wedding keeps ONE main `currency` + `budget_total_minor` — the currency the couple thinks in, whatever countries the events land in.

Other (retired) implementation notes: `pricing_region` was **state-granular** (`au-nsw` … `au-nt`, `au-other`, `international`). The profile save is `PUT` with PATCH semantics (the app's CORS method list has no PATCH) — **this remains** for the surviving `currency`/`budget`/`wedding_date` fields. The **slug is read-only** in Settings — a rename frees the old slug for another organiser to claim while printed invite links still point at it (WP-S-M1 in [[security]]); renames stay unshipped until a slug-tombstone design exists. The Settings tab is visible to co-hosts read-only and the profile save is owner-only. (The geocode POST is gone.)

### 3.2 Households ≠ claim codes

**REVERSED (2026-07-15, product-owner decision): households always carry a code.** There is **no code-less path**. PR 4 shipped then was rolled back the same day: migration `0033_households_require_code.sql` rebuilt `families` back to `public_id text NOT NULL` + a full column-level UNIQUE (dropping 0032's partial `families_public_id_uniq` index) via the same `__keep_*` FK-preserving idiom — ids copied verbatim so the cascade subtree (guests/sessions/guest_events/rsvps/guest_account_links) kept every FK, proven by `db/migration-0033.test.ts` (zero orphans), T-S1 green. **0032 is KEPT in history** (it already ran on prod D1; deleting it would desync a fresh D1) — 0033 is a forward reversing migration, not a `git revert`. It **fails loud** if any code-less household (`public_id IS NULL`) still exists (the NOT NULL rebuild naturally rejects a NULL row — a human must mint that household a real code first, no silent coercion). The PR-4 `services/households.ts` + `services/issue-invite.ts` + their routes/metrics/schemas were deleted; `family-deactivate` no longer special-cases code-less households; the organiser `GuestTable` is back to grouping by `publicId` with no "No code yet" / "Issue invite" UI. Import auto-mint (`generateFamilyCode`, `services/import.ts:152`) is unchanged — it always minted a code per family. The editor (E5, §3.3) creates households with an **auto-minted code** (no code-less path). The strikethrough design below is **retained for historical context only**.

~~Make `families.publicId` **nullable** (partial unique index `WHERE public_id IS NOT NULL`), and move code lifecycle semantics into the invite module:~~

- A household can be created with **no code**; the Guests module creates/edits households and guests directly.
- "Issue invite" (per household or bulk = the existing re-mint machinery in `services/remint-codes.ts`) mints the code — this is the moment a guest-list record acquires an invite credential.
- **Import keeps auto-minting (decided 2026-07-08)**: spreadsheet-imported households still get a code at apply time (`generateFamilyCode`, `services/import.ts:152`) — the sheet *is* the invite list and the current workflow is preserved. Only manually-created households start code-less. Import revert is unaffected (it restores snapshot `publicId`s).
- `sessionAuth` / `POST /api/claim` are unchanged (they already look up by `publicId`; null simply never matches).
- **Migration mechanics**: SQLite can't `ALTER` away `NOT NULL` — this is a full `families` rebuild, and `families` parents `guests` + `sessions` with `ON DELETE CASCADE` under D1's enforced FKs. Use the `__keep_*` snapshot/restore idiom from `0006_multi_tenant.sql`; recreate the unique index as partial (`WHERE public_id IS NOT NULL`); mirror all three DDL surfaces (schema.ts / migration / test `setup.ts`). This is the riskiest artifact in Phase 0 — land the T-S1 lockstep test **before** it.
- Code-lifecycle columns (`codeSharedAt`/`firstOpenedAt`/`deactivatedAt`) stay on `families` as "invite state, null until an invite exists"; deactivation remains strictly an invite concept (kills the code, guest data untouched) — no household archiving in Phase 0.
- Alternative considered: extracting a 1:1 `family_invites` table. Cleaner conceptually, but the migration + join tax across ~10 services isn't justified when three nullable columns and a partial index express the same thing. Revisit only if invite-channel state grows (e.g. per-channel delivery tracking).
- UI language: "Households" in the Guests module; "families" stays as the table name (rename cost > benefit).

### 3.3 Direct guest + event editing

The import stays (it's a strength) but stops being the only writer.

**Endpoint shape amended 2026-07-12 — batch draft-save, not per-row CRUD** (full design in [[guest-event-editor]]; [[deferred]] Resolved): the editor accumulates changes client-side and submits a whole desired state through the SAME preview → warnings → apply pipeline the import uses (`POST .../changes/{preview,apply,revert}` + `GET .../changes/list`), with an ID-aware diff so editor renames are updates rather than remove+create. Preview-diff, impact warnings, checkpointing, and revert are shared with the import instead of rebuilt per endpoint, and a save session produces one checkpoint. Per-row endpoints may land later as sugar over the same reconcile. The original sketch this supersedes was `POST/PATCH/DELETE .../guests/households`, `.../guests/households/:familyId/guests`, per-guest `PUT .../attendance`, and `POST/PATCH/DELETE .../schedule/events`; household notes/tags are still wanted, now as draft fields.
- **Organiser-recorded RSVPs — SHIPPED (PR 5b)**: `PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId` (`weddingEditor()`-gated) — phone/paper RSVPs land in the same `rsvps` table the invite writes to (upsert on `(guest_id, event_id)`, last-writer-wins, so an organiser reply visibly overwrites a guest one and vice-versa). Migration `0037_rsvp_consent_source.sql` added `consent_source` (`'guest' | 'organiser_attested'`, NOT NULL DEFAULT `'guest'`, legacy rows back-filled `'guest'`). **Design choice: ONE column carries BOTH the writer attribution AND the Art. 9 consent basis** — the writer and the consent-attester are always the same principal (guest self-attests; organiser attests on the guest's behalf), so a separate `recorded_by` would be 1:1 redundant. Dietary keeps its Art. 9 story (§10): the record UI gates dietary behind an "I confirm the guest consented…" attestation checkbox, the API 422s a non-empty dietary without it, and the same `dietary_consent_at`/`_version` record is stamped. The RSVP report gained a "Recorded By" column; the dashboard badges organiser-entered replies. Deliberately NOT routed through `changes/*` — RSVPs sit outside the reconcile pipeline (§5). Compliance updated: [[../../wiki/compliance/dpia/cire-guest-data|DPIA]] (organiser-attested C-H2 variant), [[../../wiki/compliance/data-map|data-map]], [[../../wiki/compliance/retention|retention]].
- **Provenance column (decided 2026-07-08)**: `source: 'import' | 'manual'` on `families` + `guests`. Once organisers can hand-add rows, a re-applied sheet that lacks them would otherwise propose deleting them — `diffAgainstDb` reconciles the whole wedding. The diff manages `import`-sourced rows only by default, with an explicit "also remove manual rows" toggle; free "added by hand" badge in the UI. (`guests.externalId` already half-anticipated this.)
- **Un-invite guard**: deleting a `guest_events` row for a pair that has an RSVP gets the same explicit state-loss confirm the import preview shows — no silent discarding of real answers.

### 3.4 API + portal re-organisation

- Module routers under `/api/organiser/weddings/:weddingId/{guests|schedule|invite|vendors|budget|tasks|seating|settings}`; guest-site public routes untouched. **Alias layer for one release (decided 2026-07-08)**: mount the same factories at old + new prefixes, delete the old prefix next release. Lockstep-only was rejected — the Worker and Pages bundles deploy in one CI run but not atomically, and organisers hold cached portal bundles after the Worker flips, so a lockstep move guarantees a broken window.
- Portal IA: replace the flat `DashboardTabs` with a **module sidebar** — Overview (new home: countdown, RSVP totals, open tasks, budget snapshot), Guests, Schedule, Invite, Vendors, Budget, Checklist, Settings. Extend `lib/dashboard-route.ts` hash routing to `#/w/:weddingId/:module/:sub`. `GettingStarted` becomes the Overview's empty-state. **Shipped (PR 3, 2026-07-15)** — with one scope note: only the modules whose surfaces exist today are on the rail (Overview / Schedule / Guests / Invite / Settings); Vendors / Budget / Checklist are **not** shown as empty nav entries (they'd mislead pre-Phase-1) — they live as honest "coming soon" snapshot cards on Overview and get promoted to rail modules when their tables ship. `ModuleShell` + `ModuleSidebar` + `Overview` are the new components; existing tabs rehomed into modules + per-module sub-tabs (Guests: Households/RSVPs; Invite: Design/Codes; Settings: Profile/Co-hosts). Legacy `#/weddings/:id/:tab` bookmarks alias to the new (module, sub) for one release (delete next release) — same one-release-alias spirit as the API prefix move above. Overview snapshots use no fabricated data (the no-mock-data rule): the Checklist/Budget cards read as promises, and a dateless wedding shows "No date yet", not a fake countdown.
- Fix P-I3 (root Performance Backlog) as part of this: lift guests/events fetches to the dashboard shell so module navigation doesn't refetch. **Shipped (PR 3)**: added `lib/guests-store.ts` (a weddingId-keyed guest cache, the sibling of the existing `events-store.ts`); `GuestTable` now reads guests from it and its event-name chip map from the shared events cache, dropping the duplicate `/events` fetch it used to fire only to build that map. `ImportPanel`'s apply invalidates both caches.

### 3.5 Roles

**Shipped (PR 2, 2026-07-12).** `wedding_hosts.role` `editor`/`viewer` + the `weddingEditor()` gate (between `weddingMember` and `weddingOwner`) landed as designed; the matrix below is now live (enforcement notes in `[[wiki/systems/cire-auth]]`, root wiki). Implementation deltas beyond the sketch: `PUT /hosts/:osnProfileId/role` (owner-gated role flip, `cire.host.role_changed` metric), `POST /hosts` takes an optional `role` (default `editor`), the wedding list tags rows `owner|editor|viewer`, family `deactivate`/`reactivate` moved up to `weddingOwner()` per the Codes row, and `preview-code` moved *down* to `weddingMember()` so viewer co-hosts can preview the invite (it was owner-only — a pre-existing gap since the header's Preview button renders for every member). Matrix:

| Capability | viewer | editor | owner |
|---|---|---|---|
| Read all modules | ✅ | ✅ | ✅ |
| Write guests/schedule/invite/vendors/budget/tasks/seating | — | ✅ | ✅ |
| Codes (mint/regenerate/deactivate), hosts add/remove, settings, delete wedding | — | — | ✅ |

Existing co-hosts map to `editor` (they already have import + invite-builder write via `weddingMember()` — see [[status]]). This closes the root-TODO co-host-roles item and matters doubly here: a hired *wedding planner* is exactly an `editor`. Cheap change: `wedding_hosts.role` has no DB CHECK constraint (`0013_wedding_hosts.sql` — enum is app-layer), so it's a data `UPDATE 'host' → 'editor'` + Drizzle enum widening + the new gate; no table rebuild.

### 3.6 Phase 0 PR slicing

| # | PR | Depends on |
|---|---|---|
| 0 | T-S1 migration-lockstep test | — |
| 1 | Wedding profile (schema + Settings view + key-optional geocoding) | — |
| 2 | ✅ Roles (`editor`/`viewer` + `weddingEditor()`) — shipped 2026-07-12 | — |
| 3 | Portal IA shell (sidebar, Overview, hash routes; existing tabs rehomed; P-I3 fetch lift) | 1 (Settings home) |
| 4 | ⛔ Households ≠ codes — shipped then **REVERSED 2026-07-15** (product-owner: every household carries a code; migration 0033 restores `public_id NOT NULL` + full unique) | 0 |
| 5 | Guest/event editing (batch draft-save — design + E1–E6 slicing in [[guest-event-editor]]) + organiser RSVPs + provenance | 3 (E5 editor-created households **auto-mint a code** — there is no code-less path) |

PRs 0–2 are parallelisable. The IA shell deliberately lands **early** (not last) so CRUD is built directly into its module home instead of into the old tabs and moved later.

## 4. Phase 1 — planning core (Overview, Checklist, Budget v1)

### 4.1 Checklist

```
tasks: id, wedding_id FK↘, title, notes, category (service-category enum + 'general'),
       due_at (nullable), timeframe_bucket ('12m'|'9m'|'6m'|'3m'|'1m'|'2w'|'week_of'|'day_of'),
       status ('open'|'done'|'skipped'), assignee_osn_profile_id (nullable, opaque usr_*),
       vendor_id (nullable FK, Phase 2), sort_order, created_at, completed_at
```

Seed from a versioned template (`cire/api/src/lib/checklist-template.ts`) resolved against `wedding_date` — "book your venue" lands at 12 months out, "final head-count to caterer" at 2 weeks. Re-anchoring when the date changes shifts *incomplete* seeded tasks only. Day-of tasks link to Schedule events → the day-of run-sheet view falls out of Schedule + `day_of` tasks.

### 4.2 Budget v1

```
budget_items: id, wedding_id FK↘, category (service-category enum), name,
              estimate_minor (nullable), quoted_minor (nullable), actual_minor (nullable),
              vendor_id (nullable FK, Phase 2), notes, created_at, updated_at
payments:     id, budget_item_id FK↘, label ('deposit'|'balance'|free text), amount_minor,
              due_at, paid_at (nullable), created_at
```

All money in **minor units** + the wedding's `currency` (no FX). Views: per-category rollup vs `budget_total_minor`, upcoming-payments list (feeds Overview + Checklist nudges). "Estimate" column is seeded by the pricing engine (§6) when available, hand-editable always.

**Multi-currency note (2026-07-10, follows the event-scoped-location decision in §3.1):** weddings can span countries, so foreign vendors (the Jaipur caterer) will quote/invoice in a currency other than the wedding's main one. **v1 stays single-currency on purpose** — every stored figure is in the wedding's MAIN `currency` (the one the couple budgets in), and the organiser converts a foreign quote when entering it. The rollup maths, the total comparison, and the pricing-engine seeding all stay trivial. If real multi-country weddings want more, the v2 extension is additive: optional `original_currency` + `original_amount_minor` (+ entered rate) on `budget_items`/`payments`, display-only — the converted main-currency figure stays the canonical amount every view sums. Tracked in [[deferred]]; do NOT build v2 speculatively.

### 4.3 Service-category enum

One closed enum shared by vendors, budget, tasks, and pricing — single source of truth in `cire/api/src/lib/service-categories.ts` (mirroring the pulse `shareSource` pattern; bounded-cardinality metric attribute):

`venue | catering | photography | videography | decor_styling | florals | music_entertainment | celebrant | cake | stationery | hair_makeup | transport | attire | other`

## 5. Phase 2 — Vendors & services

Two-stage: a private **vendor CRM** first (immediately useful, zero marketplace risk), then a shared **directory** with availability.

### 5.1 Vendor CRM (v1, wedding-scoped)

```
vendors: id, wedding_id FK↘, name, category (enum §4.3), contact_name, email, phone,
         website, instagram, location_name, lat/lng (nullable),
         price_min_minor / price_max_minor (nullable), quoted_minor (nullable),
         status ('researching'|'contacted'|'quoted'|'booked'|'declined'),
         available_on_date ('unknown'|'yes'|'no'|'tentative'),   -- v1 availability: a recorded fact
         notes, booked_at (nullable), created_at, updated_at
```

- Kanban-ish board by `status`, filter by category. Booking a vendor can create/attach a `budget_items` row (quoted → committed) and tick matching checklist tasks.
- `events.venue_vendor_id` (nullable FK) attaches a booked venue vendor to a Schedule event — address/maps fields can then derive from the vendor record.
- Vendor contact details are personal data (sole traders) → data-map/retention rows (§10).

### 5.2 Directory (v2, global) + availability

```
directory_vendors:     id, owner_osn_profile_id (nullable, opaque — self-serve claims),
                       name, category, description, location_name, lat, lng,
                       price_band ('$'|'$$'|'$$$'|'$$$$'), price_min/max_minor (nullable),
                       website/instagram/email/phone, listed ('draft'|'live'|'suspended'),
                       created_at, updated_at
vendor_availability:   directory_vendor_id FK↘, date (ISO day), status ('available'|'tentative'|'booked'|'blocked')
                       — PK (vendor, date); absence = unknown
wedding_vendor_links:  wedding_id FK↘, directory_vendor_id FK, saved_at
                       — organiser shortlists a directory listing; "import to CRM" copies it into `vendors`
vendor_enquiries:      id, wedding_id FK↘, directory_vendor_id FK, status ('sent'|'replied'|'quoted'|'closed'),
                       messages via a small vendor_enquiry_messages table (sender: organiser|vendor), quoted_minor (nullable)
```

- **Vendor identity = OSN accounts**, same `osnAuth()` verification cire already does for organisers — a third principal class (guest cookie / organiser JWT / vendor JWT is just an organiser JWT + `directory_vendors.owner_osn_profile_id` authz). No new auth system. OSN **orgs** may later model a vendor business with staff; opaque-id + `osn-bridge` ARC pattern as always, no cross-DB FKs.
- **Directory sourcing**: start curated (hand-seeded local listings; an admin import path), open self-serve claim/creation once moderation exists. External APIs (Google Places) only as a **live search overlay** for gaps — Places ToS forbids storing results, so it can never seed `directory_vendors` (§9).
- **Location search on D1** (no geospatial extension): index `lat`/`lng`, prefilter by bounding box computed from the wedding's canonical point + radius, order by haversine in SQL, `LIMIT` page. Fine for directory scale on the Free tier; revisit with a geohash column if listing count makes box scans hot.
- **"Available on your date"**: join `vendor_availability` on `weddings.wedding_date` in the search query; unknown ≠ unavailable (badge, not filter-out, by default).

## 6. Phase 3 — pricing estimates

Context-aware estimates from the wedding profile: guest count, date (season + weekday/weekend), location region, category, tier.

- **v1 — heuristic engine.** Pure function `services/pricing.ts` over a versioned dataset checked into the repo (`lib/pricing-baselines.ts`: per category → per-head or flat min/max in AUD by region bucket, seasonal + weekend multipliers). `GET .../budget/estimates` returns ranges + "based on N guests, {month}, {region}" provenance strings; Budget v1 seeds from it. Honest framing in UI: *estimates, not quotes*.
- **v2 — directory-informed.** Once enquiries/quotes flow (§5.2), blend in median quoted amounts by category within the search radius. Aggregate-only with a k-anonymity floor (suppress below ~5 data points) so no vendor's individual pricing is derivable.
- The dataset is content, not code — keep it a plain reviewed TS module with a `version` export logged on every estimate metric.

## 7. Phase 4 — seating, comms, registry

- **Seating**: `seating_tables` (id, wedding_id, event_id FK, name, capacity, sort_order) + `seating_assignments` (table_id, guest_id, PK pair; guest unique per event). Reads Guests + live RSVP status (badge declined/no-response guests). Drag-drop SolidJS island; CSV/print export for the venue.
- **Guest comms**: save-the-dates, "the invite is live", RSVP-chaser emails via `@shared/email` (Resend). Two prerequisites: **guest/household email columns don't exist** (new PII → consent at collection, data-map/retention/DPIA delta, §10) and **prod email is currently degraded** (`OSN_EMAIL_OPTIONAL=true`, root TODO "Re-enable email later"). Build behind the same key-optional/fail-soft pattern as Turnstile/Maps. Comms log table for auditability; unsubscribe/suppression from day one.
- **Registry / wishing well / guest photos / Wallet passes**: remain in [[future]]; registry is the first candidate after Phase 2 (root TODO "withjoy parity"). Payments (wishing well) deliberately out of scope until the platform core is proven.

## 8. Cross-cutting

- **Single Worker.** cire-api stays one Worker with module route factories (mirrors the osn-api single-Worker decision). D1 stays the store; everything cascades from `weddings`.
- **Observability**: per-module `cire.*` counters/histograms via the existing typed `metrics.ts`; category enums keep attribute cardinality bounded; no `console.*`; every `Effect.catchAll` logs.
- **Testing**: platform convention (`it.effect` + `createTestLayer()`), route tests per module factory; pricing engine is pure-function gold for table-driven tests; migration lockstep test (T-S1) becomes load-bearing with this much new DDL — pull it forward into Phase 0.
- **Free tier** (root `wiki/runbooks/free-tier-limits`): directory search is the only new read-hot path — one indexed query per search, no N+1; availability join bounded by date equality. D1 storage growth from vendors/tasks/budget is trivial next to R2 images. Watch Worker CPU on haversine ordering at scale.
- **Rate limiting**: writes ride the existing per-user limiter pattern; directory search + enquiries get their own Upstash limiters (enquiries are a spam vector).

## 9. Open decisions (tracked in [[deferred]])

| Decision | Options | Decide when |
|---|---|---|
| Vendor business identity | plain OSN account (recommended start) vs OSN **org** with staff | directory v2 self-serve opens |
| External discovery overlay | none (recommended start) vs Google Places live-search layer (ToS: display-only, never stored) | after directory v1 proves thin coverage |
| Pricing baseline sourcing + regions | hand-curated AU-first dataset vs licensed data | Phase 3 start |
| Guest email collection point | RSVP flow (guest-entered) vs organiser-entered vs both | Comms build; consent design first |

Decided 2026-07-08 (Phase 0 review — rows moved to [[deferred]] Resolved): import keeps auto-minting codes; `source` provenance column on families/guests; **key-optional Geocoding API** for location capture; **one-release alias layer** for the route move.

## 10. Compliance deltas (new PII classes)

Flag to the root compliance programme as each phase lands (root `wiki/compliance/*`):

- **Phase 0**: organiser-recorded dietary RSVPs — Art. 9 consent capture variant (organiser attests guest consent; record `consent_source`). **DONE (PR 5b)**: migration `0037` added `rsvps.consent_source` (`'guest' | 'organiser_attested'`); DPIA/data-map/retention updated for the organiser-attested variant; no new subprocessor. Geocoding API (organiser-typed wedding address sent to Google) → subprocessor + data-map rows; key-optional, so the degraded mode has no third-party flow.
- **Phase 2**: vendor contact details (personal data for sole traders) → data-map + retention rows; enquiry message content.
- **Phase 3 v2**: quoted-price aggregation — k-anonymity floor documented.
- **Phase 4**: guest emails (new high-sensitivity class: contactability) → data-map, retention, DPIA delta, suppression list; comms log retention.
- Wedding lat/lng + budget figures: organiser-provided, wedding-scoped; add data-map rows, low sensitivity.

## 11. Sequencing summary

**P0 (foundation)** → **P1 (checklist + budget v1)** → **P2 (vendor CRM → directory + availability)** → **P3 (pricing v1 → v2)** → **P4 (seating, comms, registry)**.

P1 and the vendor-CRM half of P2 are independent after P0 and can run in parallel branches (disjoint tables/routes). Directory v2 and pricing v2 are the long poles — both gated on real-world content (listings, quotes), not code. Ship order optimises for *an organiser gets planning value on day one* (checklist + budget + CRM) while the two-sided directory grows underneath.

Per-phase checklists: [[platform]].

## 12. Agent pick-up guide

How to pick up any phase of this plan in a fresh session. Read this section +
the phase's checklist in [[platform]] + the phase's section above; skim the rest.

### Code map (all paths from the OSN repo root)

| Area | Where | Notes |
|---|---|---|
| Route factories | `cire/api/src/routes/` | One factory per domain, composed by `createApp` in `src/app.ts` (`aot: false` — Workers forbids `new Function`). New modules = new factory + `.use()` in `createApp`. POST routes pass the sentinel `parse` hook (`{ parse: () => ({}) }`) and read `request.json()` by hand. |
| Auth gates | `cire/api/src/middleware/` | `osnAuth()` (organiser JWT), `weddingOwner()` / `weddingMember()` (per-`:weddingId` authz), `sessionAuth()` (guest cookie), `rate-limit.ts`, `turnstile.ts`. Phase 0 adds `weddingEditor()` between member and owner. |
| Services | `cire/api/src/services/` | Return `Effect.Effect<A, E>` with `Data.TaggedError` errors; routes unwrap via `runCire`. No logic in handlers; Drizzle only, no raw SQL. |
| Validation | `cire/api/src/schemas/` | Effect Schema per domain. |
| Metrics | `cire/api/src/metrics.ts` | Typed `cire.*` counters/histograms; bounded attribute cardinality only (closed enums). |
| DB schema | `cire/db/src/schema.ts` | **Three-way DDL mirror**: schema.ts + `cire/db/migrations/*.sql` + the test DDL in `cire/api/src/db/setup.ts` — mechanically enforced by `cire/api/src/db/ddl-lockstep.test.ts` (T-S1): it replays the migration chain and diffs a normalised snapshot against both mirrors, so a change to any surface fails until all three agree. Parent-table rebuilds need the `__keep_*` snapshot/restore idiom (`0006_multi_tenant.sql`) — D1 enforces FKs and DROP TABLE cascades. |
| Organiser portal | `cire/organiser/src/` | SolidJS islands in an Astro static shell; single root island `components/OrganiserApp.tsx`; hash routing in `lib/dashboard-route.ts`; per-wedding module tabs in `components/DashboardTabs.tsx` (Phase 0 replaces with sidebar); API calls via `authFetch` + `lib/api.ts`. |
| Guest site | `cire/web/src/` | Only touched when a module changes what guests see (RSVP, invite render). |
| Tests | co-located `*.test.ts` | `bun:test` (api) / vitest (organiser, web). Route tests build `createApp(createDb(":memory:"))`; osnAuth accepts an injected `osnTestKey`. |

### Invariants (do not break)

- **Tenant scoping**: every organiser read/write is scoped to `:weddingId` through the gates; tables without a `wedding_id` column (guests, guest_events, rsvps) scope via a `families`/`events` join — see the `diffAgainstDb` wedding-scoping entry in [[spreadsheet-import]] for why the join is load-bearing.
- **No cross-DB FKs**: OSN identities are opaque `usr_*` strings; resolve via the ARC-gated `services/osn-bridge.ts` (key-optional, fail-soft). Never store OSN emails/handles.
- **`events.end_at` `""` sentinel** = no stated end; anything aggregating or comparing event dates must use the effective end (`max(end_at, start_at)` — see `services/retention.ts`).
- **Host preview families** (`families.kind = 'host'`) are synthetic and must stay invisible to imports, exports, RSVP counts, and (future) seating/comms.
- **Guest PII rules**: dietary text is special-category (Art. 9 consent columns on `rsvps`); no PII in logs (redaction deny-list in `cire/CLAUDE.md`); new PII classes need [[../../wiki/compliance/data-map|root data-map]] + retention rows (§10 lists the per-phase deltas).
- Effect is **backend-only** — never import it in `cire/organiser` or `cire/web`.

### Definition of done (every platform PR)

1. Code + co-located tests (route authz cases included: 401 unauth / 403 wrong-wedding / 404 unknown).
2. Migration mirrored in all three DDL surfaces (if schema changed).
3. Wiki: tick the [[platform]] shard item, update this page if the design changed, bump `last-reviewed`, note new decisions in [[deferred]].
4. Changeset (`bun run changeset`) — `@cire/*` exact workspace names, never mixed with versioned packages.
5. `bun run --cwd cire/api test` + organiser/web suites + root `bun run check` green.

### Per-phase entry points

- **Phase 0** — start from §3.6's PR table. PR 0/1/2 are independent; PR 4 (the `families` rebuild) is the only risky migration — read §3.2's mechanics note first. The roles PR extends `middleware/wedding-member.ts` + `wedding_hosts.role` (no CHECK constraint — data UPDATE + Drizzle enum widening only). The IA PR restructures `OrganiserApp.tsx`/`DashboardTabs.tsx` + `dashboard-route.ts` and must fold in the P-I3 fetch-lift (root TODO, Performance Backlog).
- **Phase 1** — greenfield tables (`tasks`, `budget_items`, `payments`) + the shared category enum (`cire/api/src/lib/service-categories.ts`, mirror the pulse `shareSource` single-source-of-truth pattern). No auth changes; everything rides `weddingMember()`/`weddingEditor()`. Checklist template is a versioned TS module resolved against `weddings.wedding_date` (nullable — seed only when set, re-anchor incomplete seeded tasks on change).
- **Phase 2** — CRM first (`vendors`, wedding-scoped, §5.1) — it is deliberately shippable without the directory. Directory (§5.2) introduces the third principal (vendor = OSN account + `directory_vendors.owner_osn_profile_id` authz) and the D1 geo query (bounding-box prefilter on indexed lat/lng, haversine order). The event point this searches around is **no longer stored** (the `events` location columns were retired by 0036) — geocode `events.address` on-demand at search time. Check [[deferred]] for the open vendor-identity decision before building self-serve.
- **Phase 3** — pure-function engine (`services/pricing.ts`) over a versioned dataset (`lib/pricing-baselines.ts`). The old Phase 0 `pricing_region` column + its geocoding flow were **retired by migration 0036** (redundant, unbuilt-only); when this phase is built, **geocode `events.address` on-demand** to derive the region then (no stored copy). v2 (directory quote blending) needs the k-anonymity floor from §6 — do not ship aggregates without it.
- **Phase 4** — seating consumes Guests + RSVPs (watch the host-family and `""`-endAt invariants); comms is **blocked** on guest email columns (consent decision in [[deferred]]) and prod email being enabled (root TODO "Re-enable email later") — build key-optional/fail-soft regardless.
