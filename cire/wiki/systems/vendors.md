---
title: Vendors — directory, CRM, and email-verification claim
tags: [systems, cire, vendors, phase2]
related:
  - "[[cire-auth]]"
  - "[[budget]]"
  - "[[checklist-tasks]]"
last-reviewed: 2026-07-17
---

# Vendors — directory, CRM, and email-verification claim

The Vendors slice introduces a **three-tier principal model** (guests / organisers / vendors), a wedding-scoped **Vendor CRM** for organisers, a global **directory** of vendor profiles, and an **email-verification claim flow** that lets a vendor bind their directory listing to their OSN org. PR A (this slice) ships the backend foundation, CRM, and claim backend. PR B (the `vendor.cireweddings.com` portal app) is deferred.

---

## Database — four new tables (migration 0040)

### `directory_vendors`

Global directory of vendors. One row per vendor business (not per wedding). Seeded by the organiser CRM (see claim flow below).

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `dv_*` prefixed CUID |
| `org_id` | `text UNIQUE` — OSN org id (`org_*`); NULL until claimed |
| `name` | Vendor/business display name |
| `category` | FK → `directory_vendor_categories.id` |
| `email` | Contact email (sole-trader PII — see compliance) |
| `phone` | Contact phone (optional; sole-trader PII) |
| `website_url` | Optional public website |
| `description` | Markdown bio / service description |
| `status` | `enum('active','suspended','pending')` |
| `created_at`, `updated_at` | Timestamps |

**Constraint:** `org_id UNIQUE` — one directory profile per OSN org. A brand with multiple verticals (e.g. photo + video) uses a second OSN org (one profile per org).

### `directory_vendor_categories`

Reference enum table for vendor service categories (photographer, florist, caterer, …). Seeded at migration time. Many categories per profile via the join table `vendors_to_categories` (created in migration 0040).

### `vendors`

Wedding-scoped vendor CRM rows. Each represents an organiser's record of a vendor they are researching or have booked for **a specific wedding**. Linked to `directory_vendors` via `directory_vendor_id` (nullable — a CRM entry may precede the vendor having a directory profile, or the organiser may not have verified the link yet).

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `ven_*` prefixed CUID |
| `wedding_id` | FK → `weddings.id` |
| `directory_vendor_id` | Nullable FK → `directory_vendors.id` |
| `name` | Organiser's local label (may differ from directory name) |
| `category` | Service category |
| `status` | `enum('researching','shortlisted','contacted','booked','declined')` |
| `email` | Contact email captured in CRM (sole-trader PII) |
| `phone` | Optional phone (sole-trader PII) |
| `contact_name` | Optional contact person name (sole-trader PII) |
| `notes` | Organiser free text |
| `available_on_date` | Organiser-confirmed availability fact |
| `created_at`, `updated_at` | Timestamps |

### `vendor_claims`

Records of in-progress or completed email-verification claims. An organiser seeds a directory listing from their CRM entry; the system mints a short-lived claim token and records the target email here. The vendor consumes the token via the portal, binding the listing to their OSN org.

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `vc_*` prefixed CUID |
| `directory_vendor_id` | FK → `directory_vendors.id` |
| `email` | Email address the claim was sent to (sole-trader PII) |
| `token_hash` | SHA-256 hash of the raw claim token (never stored clear) |
| `status` | `enum('pending','consumed','expired')` |
| `expires_at` | 7-day TTL from minting |
| `consumed_at` | Timestamp when the vendor consumed the token |
| `consumed_by_org_id` | OSN org id that claimed the listing |
| `created_at` | Timestamp |

---

## Three principals

| | Guest | Organiser | Vendor |
|---|---|---|---|
| Credential | Claim-code → `cire_session` cookie | OSN passkey → ES256 access JWT | OSN passkey → ES256 access JWT **+ OSN org membership** |
| Token | Opaque 256-bit session (hashed at rest) | `aud:"osn-access"` JWT, `sub = usr_*` | Same access JWT; org membership resolved over ARC |
| Routes gated | `/api/rsvp` | `/api/organiser/*` | `/api/vendor/*` |
| Middleware | `sessionAuth()` | `osnAuth()` + `weddingOwner/Editor/Member()` | `osnAuth()` + `vendorOrgMember()` |
| Source of identity | `families.public_id` claim code | OSN account / profile | OSN account + OSN org (`org_*`) |

Guests and the guest cookie path are unchanged (see [[cire-auth]] §Guest path). Organisers are unchanged ([[cire-auth]] §Organiser path). Vendors are the new third principal.

---

## Vendor principal — OSN org membership via ARC

`vendorOrgMember()` (middleware in `cire/api/src/middleware/vendor-org-member.ts`) gates `/api/vendor/*`. It:

1. Calls `osnAuth()` to verify the caller has a valid `aud:"osn-access"` JWT → `c.var.osnProfileId = sub`.
2. Makes an ARC-gated S2S call to `@osn/api` `GET /organisations/internal/:orgId/membership` (scope `org:read`) to confirm the caller's OSN profile is a member of the org identified by the request context.
3. Sets `c.var.vendorOrgId` and `c.var.directoryVendorId` for downstream handlers.
4. Returns **403** if the profile is not a member; **503** (fail-soft) if the ARC call is unavailable.

**Scope:** `org:read` — resolves org membership without exposing the org's full member list. cire-api's ARC key registration (`POST /graph/internal/register-service`) must include this scope alongside `graph:read` and `graph:resolve-account` (see [[../../../wiki/runbooks/production-deploy]] §6.2).

**ARC bridge pattern:** identical to the existing `graph:read` / `graph:resolve-account` bridges (co-host handle resolution, guest account-linking). Key-optional + fail-soft: absent ARC key → 503, never a bypass.

**One profile per org / many-categories per profile:** `directory_vendors.org_id` is UNIQUE — one directory listing per OSN org. An org wanting separate listings per vertical (photo vs video) needs a second OSN org. Many service categories are supported via the `vendors_to_categories` join table.

---

## Email-verification claim flow

The claim flow lets an organiser assert "this CRM entry is the same business as that directory listing" and lets the vendor confirm ownership by clicking a link sent to the business email.

### Step-by-step

1. **Organiser seeds the directory.** `POST /api/organiser/weddings/:weddingId/vendors/:vendorId/seed-directory` (`weddingEditor()`-gated). cire-api:
   - Creates or upserts a `directory_vendors` row from the CRM entry's `name`, `category`, `email`, `website_url`.
   - Mints a 256-bit claim token; stores its SHA-256 hash in `vendor_claims` (`status: 'pending'`, 7-day TTL).
   - Returns the claim link (`/claim?token=<raw>`) **to the organiser** in the response body.

2. **Organiser receives the claim link.** The link is returned in the API response — the organiser can forward it to the vendor (copy-paste, WhatsApp, email). A **fail-soft email** is also attempted: `@shared/email` `vendor-claim-invite` template fires asynchronously; if it fails (missing `RESEND_API_KEY`, unreachable Resend), the error is logged but the HTTP response is not affected.

3. **Vendor consumes the claim.** The vendor navigates to `vendor.cireweddings.com/claim?token=<raw>` (PR B — not yet live), signs in with their OSN account, picks or creates an OSN org, and `POST /api/vendor/claim` is called with the raw token + their org id. cire-api:
   - Looks up `vendor_claims` by token hash (SHA-256 of the raw value presented).
   - Validates: `status = 'pending'`, `expires_at > now`.
   - Sets `directory_vendors.org_id = <their org>` (atomically in a D1 batch with the claim status update to `consumed`).
   - The directory listing is now **bound to the vendor's OSN org** — the vendor principal model applies from this point.

### Fail-soft email

The `vendor-claim-invite` email template (`shared/email/src/templates/vendor-claim-invite/`) is sent with the claim link and a brief call-to-action. Email sending is non-blocking: if `RESEND_API_KEY` is absent or Resend is unreachable, the error is logged (`Effect.logWarning`) and the seed endpoint returns 200 with the claim link regardless. The manual forwarding path (organiser copies the link) is always available.

---

## Organiser Vendor CRM

Routes: `/api/organiser/weddings/:weddingId/vendors` — gated by `osnAuth()` + appropriate wedding gate.

| Method | Route | Gate | Description |
|---|---|---|---|
| `GET` | `/vendors` | `weddingMember()` | List CRM entries (filtered by category, status) |
| `POST` | `/vendors` | `weddingEditor()` | Create CRM entry |
| `GET` | `/vendors/:vendorId` | `weddingMember()` | Get single entry |
| `PUT` | `/vendors/:vendorId` | `weddingEditor()` | Update entry |
| `DELETE` | `/vendors/:vendorId` | `weddingEditor()` | Delete entry |
| `POST` | `/vendors/:vendorId/seed-directory` | `weddingEditor()` | Seed global directory + mint claim token |

Service: `cire/api/src/services/vendors.ts` — `vendorsService` (Effect). Module: `cire/organiser/src/modules/Vendors/` — `VendorsView`.

---

## Vendor portal routes (PR B consumes these)

Routes: `/api/vendor/*` — gated by `vendorOrgMember()`.

| Method | Route | Description |
|---|---|---|
| `POST` | `/vendor/claim` | Consume a claim token; bind listing to caller's org |
| `GET` | `/vendor/listing` | Get the caller's directory listing |
| `PUT` | `/vendor/listing` | Update listing details |
| `GET` | `/vendor/listing/categories` | Get assigned categories |

---

## Deferred to later cycles (NOT in this PR)

- **`vendor.cireweddings.com` portal frontend** (PR B) — the Astro+SolidJS Pages app for vendor sign-in, org create/pick, listing editor, and the `/claim` landing page. Its `deploy-cire-vendor` CI job, DNS, and `vendor.` allowlist additions to cire-api `WEB_ORIGIN` + osn-api origins.
- **Directory browse** — public/organiser-facing vendor search with lat/lng bounding-box prefilter + haversine sort (requires `location` columns on `directory_vendors`).
- **Availability calendar** — `vendor_availability` per-day status; "available on your date" badge.
- **Enquiries** — `vendor_enquiries` + messages; quotes feed `budget_items.quoted_minor`; spam limiter.
- **Pricing estimates** — heuristic engine v1 (`services/pricing.ts` over `pricing-baselines.ts`); directory-informed v2 (median quoted amounts by category, k-anonymity floor ~5).
- **Budget / task / event linkage** — booking creates a `budget_items` row; ticks matching `tasks`; `events.venue_vendor_id`.
- **Date / location search** — filter by `vendor_availability` + radius from wedding's canonical geocode point.
- **Vendor moderation** — `suspended` state; cire admin tool.

---

## Related

- [[cire-auth]] — full auth model; organiser JWT verification chain; ARC bridge pattern
- [[budget]] — budget items that vendor bookings will feed (deferred linkage)
- [[checklist-tasks]] — tasks that vendor bookings will tick (deferred linkage)
- [[../../../wiki/systems/arc-tokens]] — ARC token pattern used by the `org:read` bridge
- [[../../../wiki/compliance/data-map]] — vendor contact PII fields
- [[../../../wiki/compliance/retention]] — vendor data retention rows
- [[../../../wiki/runbooks/production-deploy]] — §6.2 cire-api ARC key re-registration with `org:read`
