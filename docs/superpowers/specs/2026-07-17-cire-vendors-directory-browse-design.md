# cire Vendors S3 — Directory Browse (organiser-only) Design

**Scope:** cire Phase 2, Vendors slice 3. Adds a consumer-side **directory browse** for organisers: signed-in couples browse published vendor listings from their wedding dashboard, filter by category / keyword / location, view a listing's detail, and **add a listing to their wedding CRM** in one action. Builds directly on the `directory_vendors` foundation shipped in Vendors PR A/B; no new app, domain, or auth principal.

## Goal

Give organisers a way to discover published vendors and pull them into their per-wedding CRM without leaving the dashboard. Today the only way a vendor enters a couple's CRM is the organiser typing it in (optionally seeding + inviting a directory listing). S3 adds the reverse: browse the directory of `live` listings and click **Add to my wedding**, which creates a linked CRM row. This is the read side of the two-sided directory; enquiries (S4), availability/date-search (S5), and pricing (S6) build on it later.

## Non-Goals (deferred to later slices)

- **Public / unauthenticated browse.** Browse is gated to authenticated organisers on `host.cireweddings.com`. A fully public marketplace is a separate, larger slice (and the trigger for DSA Art. 30 work — see Compliance).
- **Enquiries / messaging / booking** (S4) — no on-platform contact or contracting in S3; the detail view shows the vendor's own contact details and the organiser reaches out off-platform.
- **Availability / date search** (S5) and **pricing/estimates** (S6).
- **Geo search** — location is a free-text `LIKE` match on `location_text`, no lat/lng, no radius (that lands with S5's "directory search" in [[todo/platform]]).
- **Favourites / shortlist** — the couple adds directly to the CRM; no intermediate saved list.
- **Sorting controls** — a single deterministic order (see Data & endpoint); no user-chosen sort.

## Resolved design decisions (from brainstorming)

1. **Audience & placement:** organiser-only, as a new **"Browse" sub-tab inside the existing Vendors module** (the CRM stays the "My vendors" tab). Same organiser JWT + `weddingMember` gate as the rest of the dashboard.
2. **Filters:** category + keyword + location (free text). No price filter, no sort control.
3. **Add-to-CRM category:** a directory listing can carry several categories; the CRM row has one. On add, if the listing has one category use it automatically (one-click); if several, prompt the couple to pick which category to file it under. Add snapshots name + contact, links `directory_vendor_id`, and **blocks adding the same listing to the same wedding twice**.

## Data model (cire/db, additive)

No new tables. One additive migration (`0041_directory_browse.sql`, mirrored in `schema.ts` + `setup.ts` per the lockstep invariant):

1. **Dedup guard** — a partial unique index enforcing one CRM row per (wedding, directory listing):
   ```sql
   CREATE UNIQUE INDEX vendors_wedding_directory_uniq
     ON vendors (wedding_id, directory_vendor_id)
     WHERE directory_vendor_id IS NOT NULL;
   ```
   Manually-added CRM rows (`directory_vendor_id IS NULL`) are unaffected — a couple can still have many manual "Photographer" rows.

2. **Browse filter index** — the browse query filters on `listed`:
   ```sql
   CREATE INDEX directory_vendors_listed_idx ON directory_vendors (listed);
   ```
   The category filter reuses the existing `directory_vendor_categories_category_idx`.

**Lockstep:** the migration, `cire/db/src/schema.ts`, and `cire/api/src/db/setup.ts` DDL must agree (`ddl-lockstep.test.ts`). `_journal.json` stays frozen (hand-numbered migrations, applied by CI `wrangler d1 migrations apply --remote` on merge — a **prod DB migration**, authorized at merge time).

## Backend (cire/api)

### Browse service — `directoryService.browse`

Add one method to the existing `directoryService` (`cire/api/src/services/directory.ts`):

```
browse(weddingId: string, filter: {
  category?: CategoryKey | null,
  q?: string | null,          // keyword, matched against name + description
  location?: string | null,   // matched against location_text
  limit: number,              // clamped 1..50, default 24
  offset: number,             // >= 0, default 0
}): Effect<{ listings: BrowseListingDto[]; total: number }, never, DbService>
```

- Base filter: `directory_vendors WHERE listed = 'live'`. Draft/other states are never returned.
- `category` → `INNER JOIN directory_vendor_categories` on that category key.
- `q` → `name LIKE %q% OR description LIKE %q%` (case-insensitive; escape `%`/`_`).
- `location` → `location_text LIKE %location%` (escaped).
- Order: `name ASC, id ASC` (deterministic, stable across pages).
- Pagination: `LIMIT/OFFSET`; `total` is the count under the same filter (for "showing X of N").
- **`inWedding` annotation:** each returned listing carries `inWedding: boolean` — true when a `vendors` row exists with this `wedding_id` + `directory_vendor_id`. Computed via a single `LEFT JOIN`/subquery on `vendors` scoped to `weddingId` (no N+1).
- `BrowseListingDto` = the public subset of `ListingDto` + `inWedding`: `{ id, name, description, categories[], locationText, priceBand, priceMinMinor, priceMaxMinor, website, instagram, email, phone, inWedding }`. (Contact fields are shown — see Compliance.) `ownerOrgId`, `listed`, timestamps are omitted (internal).
- Fail-soft: a DB/query error resolves to `{ listings: [], total: 0 }` (never crashes the dashboard read), matching the existing read posture.

### Add-from-directory — reuse `vendorsService.create`

No new write service. The organiser "Add to my wedding" calls `vendorsService.create` (existing `CreateVendorInput`) with `directoryVendorId` set + a **server-side snapshot** of the listing's `name`, `email`, `phone`, `contactName` (null), and the chosen `category`, `status: "researching"`. The handler:

1. Loads the `live` listing by id (404 `listing_not_found` if missing/not live).
2. Validates the chosen `category` is one of the listing's categories (400 otherwise).
3. Creates the CRM row; the partial unique index makes a duplicate a caught constraint error → **409 `already_in_wedding`** (no-op semantics; the UI already shows "Added").

### Routes (`cire/api/src/routes/vendors.ts` — the existing vendors factory)

Two new routes on the existing wedding-scoped group (so they inherit `osnAuth` + the role gate):

- `GET  /api/organiser/weddings/:weddingId/directory` — **`weddingMember`** (any role, incl. viewer, may browse). Query params `category,q,location,limit,offset`. Returns `{ listings, total }`.
- `POST /api/organiser/weddings/:weddingId/directory/:directoryVendorId/add` — **`weddingEditor`** (writes need editor; viewers 403 `read_only_role`). Body `{ category }`. Returns the created `VendorDto` (201) or 409 `already_in_wedding` / 400 / 404.

Rate limiting: the browse GET is a cheap authenticated read behind `weddingMember`. Apply a modest per-user limiter reusing the `rateLimitMiddlewareByUser` plugin added in the export-hardening work (keyed on `osnProfileId`, fail-closed) — the add POST gets the same. If the vendors factory carries no limiter today, adding one here is in-scope (small, consistent); it is not a new limiter type.

## Frontend (cire/organiser)

### Vendors module gets a second sub-tab

- `MODULE_SUBS.vendors` becomes `["index", "browse"]` (`index` = "My vendors" CRM, existing; `browse` = "Browse directory", new). `MODULE_NAV`/`ModuleShell` render the sub-tab bar and switch on `sub`: `index → <VendorsView>` (unchanged), `browse → <DirectoryBrowseView>` (new).
- Route: `#/w/:weddingId/vendors/browse` (deep-linkable + refresh-safe via the existing hash router).

### `DirectoryBrowseView` (new component)

- **Filter bar:** category dropdown (from the shared `service-categories` mirror), keyword input, location input. Filters debounce → refetch. "Clear filters" resets.
- **Results grid:** listing cards — name, category chips, location, price band, a short description clamp. Each card: **View** (opens the detail modal) and **Add to wedding** (or a disabled **"Added ✓"** when `inWedding`).
- **Detail modal:** full description, all category chips, location, price band + range, contact (website + instagram links, email, phone), and the Add CTA. Multi-category listing → the Add action shows a small category picker (radio over the listing's categories) before confirming.
- **States:** loading (skeleton/`role="status"`), empty ("No vendors match your filters"), error (`role="alert"`, fail-soft message), and "directory is empty" first-run copy. Pagination: a **"Load more"** button (increments `offset`, appends results); `total` drives "showing X of N".
- **Add flow:** on confirm → POST add → on 201, mark the card `inWedding` (and optimistically it now appears in the CRM tab on next visit); on 409, mark `inWedding` (already added); on 403 (viewer), the Add control isn't shown (`canEdit` gate mirrors `VendorsView`).
- Accessibility (EAA — organiser portal): labelled filter controls, real buttons, `role="status"`/`role="alert"` on async states, keyboard-operable modal, category chips not colour-only.

### Store

A light `directory-store` (or extend `vendors-store`) holding the last browse result keyed by `(weddingId, filter)` so tab switches don't refetch needlessly; invalidated when an add succeeds (so `inWedding` flags stay correct). Effect is not imported (frontend). Adding from browse also invalidates the CRM `vendors-store` for that wedding so the new row shows on the CRM tab.

## Data flow

1. Organiser opens Vendors → Browse. `DirectoryBrowseView` calls `GET …/directory` (weddingMember) with current filters.
2. cire-api `directoryService.browse` returns `live` listings + `inWedding` flags + `total`.
3. Organiser opens a listing detail, clicks **Add to my wedding**, picks a category if prompted.
4. `POST …/directory/:id/add` (weddingEditor) snapshots + links + creates the CRM row (409 if already there).
5. UI marks the card **Added**; the CRM tab reflects the new `researching` vendor.

## Compliance posture (DSA Art. 30)

The directory browse is **access-controlled to authenticated organisers** (registered couples), not an open public marketplace, and S3 has **no on-platform contracting, booking, or payment** — the organiser contacts vendors off-platform using the displayed details. On that basis the DSA Art. 30 "online platform allowing consumers to conclude distance contracts with traders" trader-traceability obligation **does not yet bite**. This is documented, and the gate (collect business name/address/registration/self-declaration before a listing goes `live`) is **revisited when either a public browse or on-platform enquiries/booking ships** (tracked as the deferred `VP-C-M3` in [[todo/security]]).

**Data-map delta:** no new personal data is collected. Existing `directory_vendors.email`/`phone` (already mapped in PR A, Art. 6(1)(f) legit-interest business-directory basis) gain a **new recipient/surface**: they are now displayed to a wedding's authenticated organisers via browse. Add a one-line note to `wiki/compliance/data-map.md` recording the new surface. No retention change.

## Error handling

Soft-fail throughout: a browse query error resolves to empty results (never a 500 that blanks the dashboard); every read + write is `weddingId`-scoped so a foreign wedding id is a 404/403, never a cross-tenant leak; add is idempotent (409 on duplicate, not a second row); a non-`live`/missing listing on add is a 404. Tagged errors (`Data.TaggedError`) per failure, `catchTag` per route.

## Testing

- **directoryService.browse** (`it`/bun:test + in-memory D1): `live`-only (draft excluded); category filter; keyword filter (name + description); location filter; combined filters; pagination + `total`; `inWedding` flag true/false; wedding-scoping of the `inWedding` join (a listing added to wedding A is not `inWedding` for wedding B); fail-soft on error.
- **add-from-directory:** creates a linked CRM row snapshotting name/contact + chosen category + `researching`; rejects a category not on the listing (400); 404 on missing/non-live listing; **409 on duplicate** (partial unique index); viewer 403.
- **routes:** `GET /directory` weddingMember read (viewer 200); `POST …/add` weddingEditor (viewer 403); cross-tenant 404.
- **migration:** `0041` applies; `ddl-lockstep.test.ts` green (migration ↔ schema.ts ↔ setup.ts); the partial unique index rejects a second (wedding, directory_vendor_id) row and permits multiple `NULL` directory refs.
- **cire/organiser:** `DirectoryBrowseView` renders results, filters refetch, "Added ✓" reflects `inWedding`, multi-category add prompts, add invalidates the CRM store; viewer sees no Add control. Store fetch-lift once-only.

## Future directions (captured in review — out of scope for S3, none blocks it)

S3 is deliberately the **location-optional** foundation these build on; all filters are optional, so browse works before a venue is chosen.

1. **Location-aware surfacing (extends S5 "directory search").** Beyond the free-text `location_text` filter, rank/surface vendors **near the wedding's events** — lat/lng bounding-box prefilter + haversine ordering from the wedding's canonical point (the S5 item in [[todo/platform]]). This is an additive ranking layer over the same `browse` endpoint; S3's free-text filter is the manual fallback.

2. **Venue-discovery when there is no location yet.** A wedding/event may be created before a venue is chosen (no `location_text`/coords). In that state, location-aware surfacing can't run, so the couple uses **manual browse (S3) to choose a venue**. A later flow can let "add a venue vendor" optionally **set the event's location** from the chosen listing (ties into the `events.venue_vendor_id` "Venue link" item in [[todo/platform]]). Additive; S3 already handles the no-location case because its filters are optional.

3. **Free (invites) vs paid (wedding-management platform) tiering.** The management modules (Checklist, Budget, Vendors incl. this directory) may become a **paid tier** layered over the free invite product. If so, the directory browse becomes a **tier-gated feature**. This is a distinct product + billing decision with its own brainstorm (recorded in [[todo/deferred]]); S3 ships **ungated** for now (single live wedding, no billing system exists), with the tier gate a later wrapper around the Vendors module — not a change to S3's internals or endpoints.

## Ship shape

**One PR** — `feat/cire-vendors-directory-browse` — all additive:
- migration `0041` (partial unique index + `listed` index) + schema.ts + setup.ts,
- `directoryService.browse` + the add handler + the two routes,
- the organiser Browse sub-tab + `DirectoryBrowseView` + store,
- docs (`wiki/systems/vendors.md` browse section, `wiki/compliance/data-map.md` surface note, `todo/platform.md` S3 check-off + `todo/security.md` VP-C-M3 note), empty changeset (cire unversioned),
- `/prep-pr` perf + security/EAA reviews before merge, subagent-driven-development execution.

The migration is an **additive prod DB change** applied on merge — authorized at merge time. No new secrets, no new subdomain, no new allowlist entries.
