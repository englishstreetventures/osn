# cire Vendors — Slice 1 (Foundation + thin CRM + thin Portal) Design

**Status:** Approved 2026-07-16
**Scope:** cire Phase 2, first slice. Establishes the vendor identity/schema foundation (S0), a thin organiser-side Vendor CRM (S1), and a thin vendor portal on `vendor.cireweddings.com` (S2).

## Goal

Give organisers a private per-wedding vendor CRM, and give vendors a self-service portal where they register their business **via an OSN organisation** and publish a directory listing. An organiser can seed a listing for a vendor they already work with and invite them (by email) to claim it. This lays the two-sided rails the later directory (browse, enquiries, availability, search, pricing) build on.

## Non-Goals (explicitly deferred to later cycles)

- Directory **browse/search** UI for organisers (S3).
- **Availability** calendar + "available on your date" join (S5).
- **Enquiries / messaging / quotes** between organiser and vendor (S4).
- **Location/date search**, geocoding, radius (S5).
- **Pricing signals** (S6).
- **Budget / task / event linkage** from the CRM (`budget_items.vendor_id`, task ticking, `events.venue_vendor_id`) — a later cycle; the CRM stays standalone here.
- **Multiple listings per org** — one business profile per org (a separate brand = a separate OSN org).
- **Vendor staff management UI** — vendors manage org membership in the OSN social app; the portal only reads membership.

## Resolved design decisions

- **Vendor identity = an OSN organisation.** The vendor business is an OSN org (`organisations` table, already built). A listing is owned by an org via an **opaque `owner_org_id`** (org id string, e.g. `org_*`) — no cross-DB FK, per the osn-bridge convention.
- **One profile per org, many categories per profile.** A listing carries a *set* of service categories via a join table, so a decor-and-catering business is one profile discoverable under both categories. A genuinely separate brand creates a second org.
- **CRM rows are single-category** (the organiser's private note; other services go in `notes`).
- **Claim = email verification.** Organiser-initiated for this slice (no browse UI needed): seed a listing + email the vendor a claim link. The vendor-initiated "search & claim" path arrives with S3; both consume the same claim token.
- **The claim link is returned to the organiser** (the primary share path — they already have the vendor relationship). cire-api email via `@shared/email` Resend is a **fail-soft enhancement** — net-new for cire-api (no email dependency today; prod delivery waits on a `RESEND_API_KEY` secret + sender-domain verification). A missing transport never blocks the invite.
- **RP ID unchanged** (`cireweddings.com` apex) → vendor OSN passkeys work on `vendor.` with no re-registration.

## Data model (cire/db, additive migration)

All timestamps are integer epoch (`integer(mode:"timestamp")`), matching the tasks/budget convention. Money is minor units, single currency (the wedding's main currency for CRM figures; a listing's price band is currency-annotated free-form for now).

### `directory_vendors` — the global business listing (one per org)
| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `dv_*` |
| `owner_org_id` | text, nullable | opaque OSN org id; NULL = unclaimed (organiser-seeded) |
| `name` | text NOT NULL | business name |
| `description` | text, nullable | |
| `email` | text, nullable | contact + claim target (personal data) |
| `phone` | text, nullable | |
| `website` | text, nullable | |
| `instagram` | text, nullable | handle or URL |
| `location_text` | text, nullable | free-text (no geocoding yet) |
| `price_band` | text, nullable | `$`/`$$`/`$$$`/`$$$$` or NULL |
| `price_min_minor` | integer, nullable | |
| `price_max_minor` | integer, nullable | |
| `listed` | text NOT NULL | `draft` \| `live` \| `suspended`; default `draft` |
| `created_at` / `updated_at` | integer NOT NULL | |

Index: `directory_vendors_owner_idx (owner_org_id)`.

### `directory_vendor_categories` — many categories per listing
| Column | Type | Notes |
|---|---|---|
| `directory_vendor_id` | text FK↘ CASCADE NOT NULL | |
| `category` | text NOT NULL | key from `service-categories` enum |

PK `(directory_vendor_id, category)`. Index on `category` for later category search.

### `vendors` — the wedding-scoped CRM row (organiser-private)
| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `ven_*` |
| `wedding_id` | text FK↘ weddings CASCADE NOT NULL | tenancy anchor |
| `directory_vendor_id` | text, nullable | set when seeded-from / linked-to a listing (opaque link, NOT a hard FK across the claim boundary — a plain nullable text ref, validated in-service) |
| `name` | text NOT NULL | |
| `category` | text NOT NULL | single key from `service-categories` |
| `status` | text NOT NULL | `researching` \| `contacted` \| `quoted` \| `booked` \| `declined`; default `researching` |
| `contact_name` | text, nullable | |
| `email` | text, nullable | |
| `phone` | text, nullable | |
| `notes` | text, nullable | |
| `quoted_minor` | integer, nullable | wedding-currency |
| `sort_order` | integer NOT NULL | default 0, within status group |
| `created_at` / `updated_at` | integer NOT NULL | |

Index: `vendors_wedding_status_idx (wedding_id, status, sort_order)`.

### `vendor_claims` — email-verification claim tokens
| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `vc_*` |
| `directory_vendor_id` | text FK↘ CASCADE NOT NULL | the listing being claimed |
| `token_hash` | text NOT NULL | SHA-256 of the emailed token (never stored plaintext) |
| `email` | text NOT NULL | address the link was sent to |
| `created_at` | integer NOT NULL | |
| `expires_at` | integer NOT NULL | TTL (e.g. 7 days) |
| `consumed_at` | integer, nullable | single-use — set when claimed |

Index: `vendor_claims_vendor_idx (directory_vendor_id)`; unique on `token_hash`.

**Lockstep invariant (T-S1):** the migration must be mirrored in `cire/api/src/db/setup.ts` DDL and `cire/db/src/schema.ts` Drizzle tables — all three agree (the `ddl-lockstep.test.ts` gate).

## Identity + org rails (S0)

- **osn-side (versioned `@osn/api` change + manual prod step):** `org:read` is **not yet in osn-api's permitted-scopes allowlist** — add it there and confirm the `/organisations/internal/*` routes are mounted (a versioned `@osn/api` change → **split changesets**, osn patch + empty cire). Then **re-register cire-api's service account per environment** with the widened scope (`graph:read,graph:resolve-account,org:read`) via the runbook §6.2 registration curl — a **manual, authorized prod step** (cannot be automated; flagged at merge). cire-api's existing bridge only holds `graph:read`/`graph:resolve-account` today.
- **cire-api osn-bridge additions:** two resolvers over ARC (scope `org:read`, aud `osn-api`):
  - `listProfileOrgs(profileId): string[]` → `GET /organisations/internal/profile-orgs?profileId=…`
  - `orgMembership(orgId, profileId): "admin" | "member" | null` → `GET /organisations/internal/membership?…`
  Fail-soft: on ARC/osn error, publish/edit degrades to 503 (never crashes), matching the existing host-add-by-handle degradation.
- **`vendorOrgMember(orgId)` gate (new middleware):** after `osnAuth()` extracts `profileId`, verify the caller owns/admins `orgId` via `orgMembership` before any write to a listing owned by that org. This is the third principal — an organiser JWT + an org-membership check, not a new auth system.

## Claim flow (email verification)

1. **Seed + invite (organiser, in CRM):** organiser adds a CRM vendor and chooses **"list in directory + invite to claim"**, entering the vendor's email. cire-api creates a `draft` `directory_vendors` (categories from the CRM row), links `vendors.directory_vendor_id`, mints a `vendor_claims` token (random, hashed at rest, 7-day TTL), and **returns the claim link to the organiser** (`https://vendor.cireweddings.com/claim?token=<token>`) so they can share it directly. If a Resend key is configured, cire-api ALSO emails the vendor the link (fail-soft).
2. **Claim (vendor, in portal):** vendor opens the link → OSN passkey sign-in → **create a new OSN org or pick one they own/admin** → confirm. cire-api validates the token (unconsumed, unexpired, matches), sets `directory_vendors.owner_org_id = orgId`, flips `listed` to `live`, stamps `consumed_at`. The vendor can now edit the listing.
3. **Self-registration (no seed):** vendor signs in → create/pick org → create a fresh listing they own outright (`owner_org_id` set immediately, `listed = live`).

Claim safety: token is single-use, hashed at rest (SHA-256), TTL-bounded; a consumed/expired/foreign token returns a generic failure. Binding requires an authenticated OSN session + org membership, so possessing the link alone is insufficient without also controlling an org.

## Frontends

### Organiser CRM module (`cire/organiser`)
- Promote a **Vendors** module onto the sidebar rail (mirrors how Checklist/Budget landed): `MODULES`, `MODULE_NAV`, `MODULE_SUBS`, `ModuleShell` render `<VendorsView weddingId canEdit canManage>`.
- `VendorsView`: per-wedding vendors grouped by `status` (researching → declined), add/edit/delete, single-category picker, contact fields, notes, `quoted_minor`; the **"list in directory + invite to claim"** action (owner/editor only). Viewer read-only (`canEdit`).
- `vendors-store` — weddingId-keyed cache + fetch-lift (sibling of `budget-store`/`tasks-store`). Overview gets a live vendor count widget (small, additive).
- Routes consumed: `/api/organiser/weddings/:weddingId/vendors` (weddingMember read; weddingEditor writes; the invite action is weddingEditor).

### Vendor portal (`cire/vendor`, new app)
- New Astro + SolidJS Pages app mirroring `cire/organiser` (SSR Cloudflare adapter, `@osn/client/solid` OSN sign-in, `@cire/theme`). Files mirror the organiser app's `astro.config.mjs`, `lib/osn.ts`, `login.astro`, `VendorApp.tsx` root.
- Screens (thin): **sign-in** → **org create/pick** (create = `POST /organisations` via the OSN client; pick = list orgs the caller admins) → **listing editor** (name, categories multi-select, description, contact, location_text, price band/min/max, publish toggle) → **claim landing** (`/claim?token=…`).
- Routes consumed (new `/api/vendor/*` on cire-api, `osnAuth()` + `vendorOrgMember` gated): `GET /api/vendor/orgs/:orgId/listing`, `PUT …/listing`, `POST /api/vendor/claims/:token/consume`, `GET /api/vendor/claims/:token` (preview the listing being claimed).

## Infra

- **New Pages project** `cire-vendor` on `vendor.cireweddings.com` + `deploy-cire-vendor` job in `.github/workflows/deploy.yml` (Direct Upload, mirroring `cire-organiser`); DNS custom domain on the `cireweddings.com` zone.
- **Allowlists:** add `https://vendor.cireweddings.com` to cire-api `WEB_ORIGIN` and osn-api `OSN_ORIGIN`/`OSN_CORS_ORIGIN`. (RP_ID stays the apex.)
- **cire-api email:** wire `@shared/email` (Resend) with a new `RESEND_API_KEY` secret; fail-soft (a missing key degrades the invite to a shown-but-not-sent state with the link surfaced to the organiser, never a hard error).

## Error handling

Soft-fail throughout: an osn-api/ARC outage degrades org resolution to 503 on writes but never crashes reads; a missing email transport surfaces the claim link to the organiser instead of erroring; every write is wedding- or org-scoped so a foreign id is a 404/no-op, never a cross-tenant leak. Tagged errors (`Data.TaggedError`) per failure, Effect `catchTag` per route.

## Testing

- **cire/api services** (`it`/bun:test + in-memory D1): vendors CRM CRUD wedding-scoped (cross-tenant 404); claim mint → consume happy path; claim rejected when consumed/expired/foreign; listing publish gated by org membership (mock the org-membership resolver); seed-from-CRM creates a linked draft listing.
- **cire/api routes:** `/vendors` two-factory read/write split (member read, editor write); `/api/vendor/*` `osnAuth` + `vendorOrgMember` gates (401 unauth, 403 non-member).
- **osn-bridge resolvers:** ARC token shape + fail-soft on error (mirror existing `osn-bridge.test.ts`).
- **cire/organiser:** `VendorsView` renders grouped-by-status, add/edit, invite action visible only to editors; `vendors-store` fetch-lift once-only; Overview vendor count.
- **cire/vendor:** listing editor renders + saves; org create/pick; claim landing consumes a token (mocked API). Component tests mirror the organiser app harness (happy-dom + mocked `authFetch`).
- **Lockstep:** `ddl-lockstep.test.ts` passes (migration ↔ setup.ts DDL ↔ schema.ts).

## Security / compliance notes

- **New personal data:** `directory_vendors.email`/`phone`, `vendors.email`/`phone`/`contact_name`, `vendor_claims.email` (sole-trader contact details). → add `wiki/compliance/data-map.md` + `retention.md` rows in the implementing PR.
- **New principal:** vendor = OSN account + org membership. Documented in `wiki/systems/cire-auth.md`.
- **New subdomain in allowlists** — a widening of `WEB_ORIGIN`/`OSN_ORIGIN` (intentional, for the new portal).
- **New outbound email** from cire-api (Resend) — subprocessor already on file (osn-api uses Resend); note the new sender context.
- **Claim tokens** hashed at rest, single-use, TTL — mirrors cire's session/guest-claim hardening.

## Ship shape

Two PRs, each independently reviewable and green:
- **PR A — foundation + CRM + claim backend:** migration + schema + `directory_vendors`/`vendors`/`vendor_claims` services + `/api/organiser/.../vendors` + `/api/vendor/*` routes + osn-bridge org resolvers + fail-soft cire-api email + the organiser `VendorsView` module, **plus the osn-api `org:read` scope-allowlist change** (split changesets: `@osn/api` patch + empty cire). Ships organiser value with no new subdomain. The manual per-env cire-api service-account **re-registration** (widened scope) is authorized at merge; until it runs, org-gated listing writes degrade to 503 (fail-soft).
- **PR B — the vendor portal app + infra:** the `cire/vendor` Astro app + `deploy-cire-vendor` job + DNS + allowlist entries.

Each PR: additive migration (PR A), empty/patch changesets per package versioning class, `/prep-pr` perf + security reviews before merge, subagent-driven-development execution.
