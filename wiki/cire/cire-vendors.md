---
title: Cire vendors
tags: [systems, cire, vendors, phase2]
related:
  - "[[cire-auth]]"
  - "[[cire-budget]]"
  - "[[cire-checklist-tasks]]"
  - "[[access-control]]"
last-reviewed: 2026-10-01
---
# Vendors — directory, CRM, and email-verification claim

> **Tier gate:** the Vendor CRM routes (`/api/organiser/weddings/:weddingId/vendors/*`), the Directory browse/add routes (`/api/organiser/weddings/:weddingId/directory/*`) and the couple's enquiry routes (`/api/organiser/weddings/:weddingId/enquiries/*`) all require the wedding to be on the **Crimson** plan tier (`weddingTier(db, "crimson")`). Requests from a wedding below it receive `402 { "error": "payment_required", "tier": "crimson" }`. The gate sits after the role check — see [[cire-entitlements]]. A host can buy Crimson from the portal, at an upgrade-from-Gold price when the wedding is on Gold; see [[cire-upgrades]].

The Vendors slice introduces a **three-tier principal model** (guests / organisers / vendors), a wedding-scoped **Vendor CRM** for organisers, a global **directory** of vendor profiles, and an **email-verification claim flow** that lets a vendor bind their directory listing to their OSN org. It landed in two slices — the backend foundation, CRM and claim backend first, then the `vendor.cireweddings.com` portal app (`cire/vendor`) with its CORS allowlist entry and deploy job. **Both are in**: `cire/vendor` builds and deploys as a Pages project from `.github/workflows/deploy.yml`, and `vendor.cireweddings.com` sits in cire-api's `WEB_ORIGIN` allowlist.

---

## Database — four tables

The schema lives in [`cire/db/src/schema.ts`](../../cire/db/src/schema.ts).

### `directory_vendors`

Global directory of vendors. One row per vendor business (not per wedding). A vendor creates their own from the portal, or an organiser seeds a draft one from a CRM row (see the claim flow below).

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `dv_<uuid>` |
| `owner_org_id` | OSN org id (`org_*`) that owns the listing; null until claimed. Unique (`directory_vendors_owner_uniq`); any number of rows may be null |
| `name` | Business display name |
| `description` | Free-text bio |
| `email`, `phone` | Contact details (sole-trader PII — see compliance) |
| `website`, `instagram`, `location_text` | Optional public details |
| `price_band`, `price_min_minor`, `price_max_minor` | Optional price guide |
| `listed` | `'draft'` (seeded, not browsable) or `'live'`; defaults to `'draft'` |
| `lead_forward_email` | The vendor's own lead-capture address, copied on a new enquiry; null until set in the portal |
| `claimed_by_profile_id` | The OSN profile that claimed the listing; the vendor-side member of any enquiry chat. Null until an operator confirms the claim |
| `review_org_id`, `review_profile_id`, `review_requested_at` | A redeemed claim waiting for an operator: the org and profile that redeemed it, and when. Null when no claim waits. `review_org_id` is unique (`directory_vendors_review_org_uniq`), so an org holds at most one pending claim |
| `created_at`, `updated_at` | Timestamps (second precision) |

### `directory_vendor_categories`

The service categories a listing offers, many per listing: `(directory_vendor_id, category)` is the primary key, and `directory_vendor_id` cascades on delete. `category` is one of the keys in [`cire/api/src/lib/service-categories.ts`](../../cire/api/src/lib/service-categories.ts).

### `vendors`

Wedding-scoped vendor CRM rows. Each is an organiser's record of a vendor they are researching or have booked for **a specific wedding**. Linked to `directory_vendors` through `directory_vendor_id`, which is null for a vendor added by hand.

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `ven_<uuid>` |
| `wedding_id` | FK → `weddings.id`, cascades on delete |
| `directory_vendor_id` | Nullable, no FK. At most one row per `(wedding_id, directory_vendor_id)` — the partial unique index `vendors_wedding_directory_uniq` |
| `name` | Organiser's label (may differ from the directory name) |
| `category` | Service category |
| `status` | `researching`, `contacted`, `quoted`, `booked` or `declined` (`VENDOR_STATUSES` in `cire/api/src/schemas/vendors.ts`) |
| `contact_name`, `email`, `phone` | Contact details (sole-trader PII) |
| `notes` | Organiser free text |
| `quoted_minor` | The vendor's quote, in minor units |
| `sort_order` | Position within its `(wedding_id, status)` group; `vendors_wedding_status_idx (wedding_id, status, sort_order)` serves the board order and the "append to the end of the group" read |
| `created_at`, `updated_at` | Timestamps |

### `vendor_claims`

Claim tokens. Minting one records the target email and the SHA-256 hash of a 256-bit token; the vendor consumes it through the portal, binding the listing to their OSN org.

| Column | Notes |
|---|---|
| `id` | `text PRIMARY KEY` — `clm_<uuid>` |
| `directory_vendor_id` | FK → `directory_vendors.id`, cascades on delete |
| `token_hash` | SHA-256 hash of the raw token, unique (the raw token is never stored) |
| `email` | Address the claim was sent to (sole-trader PII) |
| `created_at` | Timestamp |
| `expires_at` | 7 days after minting |
| `consumed_at` | Null until consumed; a token is live while this is null and `expires_at` is in the future |

---

## Three principals

| | Guest | Organiser | Vendor |
|---|---|---|---|
| Credential | Claim-code → `cire_session` cookie | OSN sign-in via OIDC → `cire_org_session` cookie | Same `cire_org_session` cookie **+ OSN org membership** |
| Token | Opaque 256-bit session (hashed at rest) | Opaque 256-bit session (hashed at rest), row carries the `usr_*` profile id | Same session; org membership resolved over ARC |
| Routes gated | `/api/rsvp` | `/api/organiser/*` | `/api/vendor/*` |
| Middleware | `sessionAuth()` | `osnAuth()` + `weddingOwner/Editor/Member()` | `osnAuth()` + inline org-member check |
| Source of identity | `families.public_id` claim code | OSN account / profile | OSN account + OSN org (`org_*`) |

Guests and the guest cookie path are unchanged (see [[cire-auth]] §Guest path). Vendors are the third principal, and since 2026-07-27 they share the organiser credential: `osnAuth()` reads the `cire_org_session` cookie first and falls back to an `Authorization: Bearer` OSN access token for callers that are not this browser (`cire/api/src/middleware/osn-auth.ts`). Everything downstream still keys on the `usr_*` profile id, so the role gates and ARC bridges did not move.

---

## Vendor principal — OSN org membership via ARC

`vendorOrgMember()` (middleware in `cire/api/src/middleware/vendor-org-member.ts`) gates `/api/vendor/*`. It:

1. Calls `osnAuth()` to verify the caller has a valid `aud:"osn-access"` JWT → `c.var.osnProfileId = sub`.
2. Makes an ARC-gated S2S call to `@osn/api` `GET /organisations/internal/:orgId/membership` (scope `org:read`) to confirm the caller's OSN profile is a member of the org identified by the request context.
3. Sets `c.var.vendorOrgId` and `c.var.directoryVendorId` for downstream handlers.
4. Returns **403** if the profile is not a member; **503** (fail-soft) if the ARC call is unavailable.

**Scope:** `org:read` — resolves org membership without exposing the org's full member list. cire-api's ARC key registration (`POST /graph/internal/register-service`) must include this scope alongside `graph:read` and `graph:resolve-account` (see [[production-deploy]] §6.2).

**ARC bridge pattern:** identical to the existing `graph:read` / `graph:resolve-account` bridges (co-host handle resolution, guest account-linking). Key-optional + fail-soft: absent ARC key → 503, never a bypass.

**One listing per org / many categories per listing:** an org owns at most one directory listing, counting a claim it is waiting on. `directory_vendors.owner_org_id` and `review_org_id` each carry a unique index, so a second listing for the same org fails at the database, and `consumeClaim` refuses a claim into an org that already owns a listing or waits on one (409 `org_has_listing`) before it spends the token. `getListingByOrg` and `upsertListingForOrg` rely on this. An org wanting separate listings per line of business (photo vs video) uses a second OSN org. `directory_vendor_categories` holds many service categories per listing.

---

## Email-verification claim flow

The claim flow lets an organiser assert "this CRM entry is the same business as that directory listing" and lets the vendor ask for the listing by clicking a link sent to the business email. The organiser chooses that address, so a redeemed link proves control of an inbox and nothing more. It never binds the listing by itself: the claim waits for an operator, who confirms or rejects it ([[#Operator review of claims]]).

### Step-by-step

1. **Organiser seeds the directory.** `POST /api/organiser/weddings/:weddingId/vendors/:vendorId/list-in-directory` (`weddingEditor()`-gated). cire-api (`directoryService.seedFromCrm`):
   - Checks the CRM row belongs to the wedding, then inserts a new `listed = 'draft'` `directory_vendors` row from the request body, with its categories, and links the CRM row to it.
   - Mints a 256-bit claim token and stores its SHA-256 hash in `vendor_claims` with a 7-day expiry.

2. **The claim link goes to the vendor by email only.** cire-api sends the `@shared/email` `vendor-claim-invite` template, carrying `/claim?token=<raw>`, to the address the organiser entered. The response never carries the link. Nothing checks that the address belongs to the vendor, so a claim proves control of that inbox and nothing more. The response is `{ directoryVendorId, invited }`, and the portal says "we emailed <address>" or, when `invited` is false, warns that the invite did not send. A couple's enquiry to an unclaimed listing mints a further token and emails it to the listing address (`issueClaimForListing`), so a listing can hold several live tokens at once.

3. **Vendor consumes the claim.** The vendor navigates to `vendor.cireweddings.com/claim?token=<raw>`, signs in with their OSN account, picks an OSN org they belong to (creating an org, if they have none, happens in the OSN app first — not the portal), and the portal calls `POST /api/vendor/claims/:token/consume` with the raw token in the path and `{ orgId }` in the body. cire-api:
   - Looks up `vendor_claims` by token hash (SHA-256 of the raw value presented) and rejects a token that is consumed or past `expires_at`.
   - Reads, in one query, the listing's owner and pending claim and whether the picked org already owns or waits on a listing. A listing that is gone, claimed or already pending fails `ClaimInvalid` (410); an org that owns or waits on a listing fails `OrgAlreadyHasListing` (409 `org_has_listing`). Neither spends the token, so the vendor can pick another org.
   - **Burns the token first**: `UPDATE vendor_claims SET consumed_at = now WHERE id = ? AND consumed_at IS NULL`. Zero rows changed means another request consumed it first, and the claim fails before anything is bound. A failure after the burn leaves the token spent and the listing unbound, never bound with a reusable token.
   - **Then records the pending claim and burns the listing's other tokens**, in one batch. The write sets `review_org_id`, `review_profile_id` and `review_requested_at`, and matches only while `owner_org_id` and `review_org_id` are both null: a second token can never move a claim to another org. It leaves `owner_org_id`, `claimed_by_profile_id` and `listed` alone, so every reader that decides "claimed" on them — `enquiries.open`, the vendor enquiry org gate, browse — still treats the listing as unclaimed: it is not live, couples' enquiries keep buffering, and no chat reaches the claimant. The second UPDATE spends every other live token for the listing. The row comes back from the write's `RETURNING`, read beside the listing's categories; a listing that has gone, been claimed or gone pending by then fails `ClaimInvalid`, with the token already spent. If the org gains a pending claim between the read and the write, the unique index stops the batch and the claim fails `OrgAlreadyHasListing`, also with the token spent. The whole claim is six statements (`directoryService.consumeClaim` in [`directory.ts`](../../cire/api/src/services/directory.ts)).
   - Logs `vendor claim awaiting operator review` with the listing id, and counts `cire.vendor_claim_review.events{event="requested"}`.
   - Returns the listing with `awaitingConfirmation: true`, which the portal carries to its editor so the editor need not fetch it again.

4. **The portal hands the listing to the editor.** The claim page writes the listing, with its contact details, to `sessionStorage` (`cire.vendor.claimed-listing`) and redirects to the dashboard at `/#/orgs/<id>`. The dashboard takes it off storage as the page loads, before anything renders and whether or not the vendor is signed in, and holds it in page memory for the first editor that opens; an editor opened for a different org drops it and fetches. The storage copy therefore lives for that one redirect. Code: `drainClaimedListing` and `takeSeededListing` in [`vendor-store.ts`](../../cire/vendor/src/lib/vendor-store.ts).

### Fail-soft email

The `vendor-claim-invite` email template (`shared/email/src/templates/vendor-claim.ts`) is sent with the claim link and a brief call-to-action. A failed send never fails the request: `sendClaimInviteEmail` logs it (`Effect.logWarning`) and resolves to `false`, and the endpoint returns 200 with `invited: false`. There is no other way to deliver the link, and listing the vendor again creates a second draft listing.

The claim page's preview (`GET /api/vendor/claims/:token`) returns 404 for a token that is spent or expired, or whose listing is gone, claimed or waiting on an operator.

### Operator review of claims

While a claim waits, the listing is `draft` with no owner. The claimant's portal shows it with an "awaiting confirmation" chip and a note, and no form: `GET /api/vendor/orgs/:orgId/listing` returns it with `awaitingConfirmation: true`, and `PUT` answers 409 `listing_awaiting_confirmation`, since a save always puts a listing live. `issueClaimForListing` mints no further token for it, so a couple's enquiry email carries no claim link.

**How the operator learns of it.** The daily cron (04:00 UTC) counts the claims still waiting. When any are, it logs `vendor claims awaiting operator review` with the count (Workers Logs, kept 7 days) and, on a deployed tier whose Worker has both `CIRE_OPS_EMAIL` and `RESEND_API_KEY`, emails that address one reminder (`vendor-claim-review-pending` in `@shared/email`). The email holds the count, the age in days of the oldest claim and the `list` command for the tier; no listing, claimant or contact detail. One email a day at most, so the reminder costs at most 31 sends a month against the Resend free plan's 100 a day and 3,000 a month (resend.com/pricing), which every cire email shares. A per-claim email was rejected: its sends grow with claims, and it would add a mail call to the request path. Each claim also writes a `logWarning` when redeemed. The metric `cire.vendor_claim_review.events` counts claims, hand-offs and reminders (`operator_alerted`, `operator_alert_error`), but cire's metrics export nothing on workerd yet ([[cire-workerd]]).

`CIRE_OPS_EMAIL` is a secret, not a `[vars]` entry, because the repository is public and the address is a person's. Set it once per tier:

```bash
cd cire/api
bunx wrangler secret put CIRE_OPS_EMAIL --env production
bunx wrangler secret put CIRE_OPS_EMAIL --env dev
```

Unset, no reminder is sent and the log line is the only signal.

**Confirm or reject** with `scripts/cire-vendor-claim-review.ts`. It runs SQL on the cire D1 through `wrangler d1 execute`, under the operator's own Cloudflare login, using the wrangler installed in `cire/api`. `--env` (`local`, `dev` or `production`) has no default, and confirm and reject are dry runs until `--apply`:

```bash
bun scripts/cire-vendor-claim-review.ts list    --env production
bun scripts/cire-vendor-claim-review.ts confirm dv_… --env production          # dry run: checks, prints the SQL
bun scripts/cire-vendor-claim-review.ts confirm dv_… --env production --apply
bun scripts/cire-vendor-claim-review.ts reject  dv_… --env production --apply
```

- **Before confirming**, decide whether the claimant is the business. The script prints the listing's email and website (both typed by the organiser, so not proof on their own) and, from the OSN D1, the claimant organisation's name and handle, the claiming profile's handle and role, and the email on the claimant's OSN account, with a line saying whether that email's domain matches the listing's website or email. A match is not proof either: the organiser typed those domains, and a mail provider anyone can sign up to matches nothing. Check the claimant against contact details for the business that you find yourself, and contact it that way when in doubt. Every stored string is printed quoted, with control characters escaped.
- **Confirm** refuses a listing with no pending claim, one already owned, an org that already owns another listing, an org OSN does not have, and a profile that has left the org. It moves `review_org_id` and `review_profile_id` into `owner_org_id` and `claimed_by_profile_id` and sets `listed = 'live'`, in one UPDATE that repeats the checked state in its `WHERE`. New enquiries go straight to the vendor from then on.
- **Reject** clears the `review_*` columns. The listing is unowned and claimable again; its tokens were all spent by the claim, so the next new enquiry thread mints the next one.
- **Record** each decision (listing id, confirm or reject, why) where the team keeps operator actions, per [[access-control#Internal admin actions on user data]].

Every value the script puts in SQL is checked against a strict id pattern first (`wrangler d1 execute --command` takes no bound parameters), and writes use `RETURNING`, so a claim that changed between the check and the write reports zero rows rather than half-applying. Tests run its SQL against SQLite built from the real cire and OSN migrations (`scripts/tests/cire-vendor-claim-review.test.ts`).

**Hand-off after a confirm.** A raw UPDATE cannot run app code, so the daily cron (04:00 UTC, `claimReviewService.sweep` in [`claim-review.ts`](../../cire/api/src/services/claim-review.ts)) hands buffered enquiries over: every open enquiry with no chat and a `pending_body`, on a listing with a `claimed_by_profile_id`, gets its chat provisioned and its first message sent (`flushBufferedEnquiry` in [`enquiries.ts`](../../cire/api/src/services/enquiries.ts)). The work is read from that state, not from a flag, so a failed hand-off stays buffered and is retried the next day. The queue is the partial index `vendor_enquiries_buffered_idx`, oldest `updated_at` first, and a failure bumps `updated_at`, so an enquiry that keeps failing moves to the back rather than holding every run's slots.

A retry reuses the chat an earlier attempt provisioned:

1. **Chat.** Reuse `handoff_chat_id` when set; otherwise provision one.
2. **Send the buffered body**, unless the reused chat already holds a message. Only this send can reach that chat, since every reply path refuses while `zap_chat_id` is null, so a message there means an earlier attempt sent it and failed to record it.
3. **Record delivery** in one UPDATE: set `zap_chat_id`, clear `pending_body` and `handoff_chat_id`, matching only while the enquiry is open with `zap_chat_id IS NULL`.

A failure after provisioning writes the new chat to `handoff_chat_id` in the same UPDATE that bumps `updated_at`, so success and failure each cost one D1 write. Any other failure keeps the chat too, including a transient one on a reused chat, or a send that landed before the attempt failed, whose retry then skips the send. Only a definite refusal from zap for that chat (403, 404, 409 or 410, `ZapChatRejected` in [`zap-bridge.ts`](../../cire/api/src/services/zap-bridge.ts)) clears `handoff_chat_id`, so the next attempt provisions a new chat rather than failing on the old one for good. A crash that skips that write, or two runners racing on one enquiry, can still leave a chat unrecorded in Zap; the daily cron runs once, so neither is expected. `zap_chat_id` alone tells readers that a thread exists, and it is set only once the body is delivered, so an open enquiry has exactly one of `zap_chat_id` and `pending_body` at all times. A run takes at most 10 enquiries (20 zap-api calls, 10 D1 writes), because the cron shares one invocation's Free-plan subrequest and D1 query ceilings with the other jobs ([[free-tier-limits]]). Until the sweep reaches an enquiry, the vendor sees it in their inbox but a reply answers 409 `awaiting_vendor`, for up to a day. Without vendor chat configured (`ZAP_API_URL`, as on dev) nothing is handed off and the cron logs that enquiries are waiting.

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
| `POST` | `/vendors/:vendorId/list-in-directory` | `weddingEditor()` | Seed a draft directory listing and email the vendor a claim link |

Service: `cire/api/src/services/vendors.ts` — `vendorsService` (Effect). Module: `cire/host/src/modules/Vendors/` — `VendorsView`.

---

## Vendor portal routes (consumed by `cire/vendor`)

Routes: `/api/vendor/*` — gated by `vendorOrgMember()`.

| Method | Route | Description |
|---|---|---|
| `GET` | `/vendor/claims/:token` | Public claim preview; 404 when the token or its listing cannot be claimed |
| `POST` | `/vendor/claims/:token/consume` | Consume a claim token; record a claim for the caller's org that waits for an operator (409 `org_has_listing` if the org already owns or waits on one) |
| `GET` | `/vendor/listing` | Get the caller's directory listing |
| `PUT` | `/vendor/listing` | Update listing details |
| `GET` | `/vendor/listing/categories` | Get assigned categories |

---

## Vendor portal (`cire/vendor`)

The vendor self-service portal (`vendor.cireweddings.com`) is an Astro + SolidJS Cloudflare Pages app living in `cire/vendor/`. It is the browser surface vendors use after an organiser sends them a claim link.

### Screens (left-to-right user flow)

| Screen | Path | Description |
|---|---|---|
| Sign-in | `/` (unauthenticated) | One button. `SignInPanel` calls `startSignIn` from `@shared/rp-auth` — a top-level navigation to cire-api's `/api/auth/oidc/start` — and the passkey ceremony happens on musubi's own origin. A second "Create account with musubi" button (`startCreateAccount`, the same call plus `prompt=create`) was removed 2026-08-06: only the issuer knows whether this person already has an account, its sign-in screen carries its own "No account yet? Create one", and asking here just made cire guess. On mount the panel also calls `resumeSession`, which asks `GET /api/auth/session` behind the rendered page and sends a vendor who still holds a cire session to the dashboard — the button shows either way |
| Org picker | `/` (authenticated, no listing) | `OrgPicker` island — lists the vendor's existing OSN orgs; on pick, transitions to the listing editor. **The portal does NOT create organisations** — an org is an OSN account-level entity created in the OSN app. A vendor with no org sees an `EmptyState` and must create one in musubi first. _Follow-up closed 2026-08-06:_ the empty state is now a **link** to `PUBLIC_OSN_ACCOUNT_URL`/settings/organisations, not two paragraphs of instructions with nothing to click. |
| Listing editor | `/` (authenticated, listing found) | `ListingEditor` island — loads the vendor's directory listing via `GET /api/vendor/listing` and lets them update name, description, category, website URL; saves via `PUT /api/vendor/listing` |
| Claim landing | `/claim` | `ClaimApp` island — renders a claim preview (listing name + organiser) from `GET /api/vendor/claim/preview?token=<raw>`; on "Accept" calls `POST /api/vendor/claim` with the raw token + selected org id; strips the token from the URL via `history.replaceState` immediately on mount (**token-strip**) |

### API surface

- **osn-api** — the portal does not call it at all. Since the 2026-07-27 OIDC swap the browser holds a cire session cookie, not an OSN token, so it has nothing to send. The caller's orgs come from cire-api's `GET /api/vendor/orgs`, which resolves them over ARC (`profileOrgs` in `cire/api/src/routes/vendor-portal.ts:52`). **Org creation is still not here** — an org is an OSN account-level entity, created in the OSN app.
- **cire-api** — `/api/vendor/*` routes gated by `osnAuth()` plus an inline ARC org-membership check. Called via the `authFetch` from `@shared/rp-auth`, which sends `credentials: "include"`. Cross-origin (portal → `api.cireweddings.com`), so cire-api's `WEB_ORIGIN` must include `vendor.cireweddings.com`.

`vendor.cireweddings.com` stays in osn-api's `OSN_CORS_ORIGIN` for now but no longer earns its place; pruning is tracked in `[[production-deploy]]`. It is **not** in `OSN_ORIGIN` — that list is the WebAuthn expected-origin allowlist, and with the RP ID on `musubi.social` a ceremony from a cireweddings.com host is illegal whatever the list says.

### Look and feel

**Redesigned 2026-08-06**, bringing across the host-portal work of #372–#378.
The portal now shares `cire/host`'s design system: the two OKLCH ramps
(dark default, light via both `prefers-color-scheme` and an explicit
`data-theme`), self-hosted Schibsted Grotesk + Cormorant Garamond, the shared
`ui/` primitives, and one sticky top bar in place of the old masthead-plus-nav-row.

The deltas — narrower measure, no italic, a three-name haptics vocabulary,
`cire.vendor.*` storage keys, a two-tab strip instead of a command palette, and
account management as a link out rather than an in-portal panel — are recorded
in **`cire/vendor/DESIGN.md`**, which is deliberately a delta document: the
system itself lives in `cire/host/DESIGN.md`.

The ramps are **copied, not imported** (a cross-package CSS import would make
Tailwind scan the other package's source). `cire/vendor/tests/styles/tokens.test.ts`
reads both stylesheets and fails on any drift between them, on top of asserting
the contrast contract.

Two consequences worth knowing about outside the portal:

- **The redesign is type-checked.** `astro check` reaching this package is
  *not* this branch's doing — `cire-vendor-type-check` landed it independently
  on main, along with fixes for the six errors it had been hiding. This branch
  arrived at the same script and (bar one) the same fixes in parallel, which is
  its own small argument that the gate was overdue. What the branch adds is a
  much larger surface for it to check: 53 files, 0 errors.
- **The CSP lost both Google Fonts origins.** `style-src` and `font-src` are
  `'self'` now that the faces are self-hosted, which the `_headers` comment had
  been anticipating. It matters most on `/claim`, opened straight from an
  emailed invite: that page used to tell Google about every vendor who followed
  a link, before rendering a word.

### Token-stripping + Referrer-Policy

The `/claim?token=<raw>` URL carries a 256-bit claim secret. Two defences prevent it leaking:

1. **Token-strip**: `ClaimApp` calls `history.replaceState({}, "", "/claim")` on mount — the token leaves the address bar before any user action or navigation.
2. **Referrer-Policy: no-referrer** header: set in `cire/vendor/public/_headers` (Cloudflare Pages static headers). Prevents any remaining `<a>` or `fetch` from forwarding the URL in a `Referer` header to third-party origins.

### Auth flow

**Rewritten 2026-07-27.** The portal no longer runs a passkey ceremony of its own — it cannot, the RP ID is `musubi.social` and `vendor.cireweddings.com` is a different registrable domain. Sign-in is now a redirect:

1. `startSignIn` (`@shared/rp-auth`) navigates the tab to cire-api `/api/auth/oidc/start`, carrying where to come back to. A vendor with no musubi account takes the same navigation and creates one on the issuer's screen. (`startCreateAccount` — the same navigation with `prompt=create` attached — still exists and cire-api still allowlists that parameter to `create`, dropping anything else so a crafted link cannot ask for a silent grant; nothing in the portal calls it since 2026-08-06.)
2. cire-api redirects to `id.musubi.social/authorize` with PKCE S256; the ceremony and consent run on musubi's own origin.
3. The issuer redirects back to cire-api's `/api/auth/oidc/callback`. cire-api exchanges the code **server-side**, reads `osn_profile_id` off the ID token, and sets its own opaque session cookie before bouncing the browser back to the portal.

The browser never holds an OSN token. `useAuth` from `@shared/rp-auth/solid` reads the session with `GET /api/auth/session` and gives islands an `authFetch` that sends the cookie; a 401 means the session is gone and the panel offers sign-in again. Account management — passkeys, recovery codes, connected apps — links out to `PUBLIC_OSN_ACCOUNT_URL` (`cire/vendor/src/lib/osn.ts`), because those are bound to the `musubi.social` RP ID.

Full contract in the OSN wiki: `[[cire-auth]]`, `[[oidc-provider]]`, `[[musubi-identity-migration]]`.

---

## Directory browse (organiser, S3)

Shipped 2026-07-18. Adds a **Browse** sub-tab inside the organiser Vendors module, backed by two new API endpoints.

### `GET /api/organiser/weddings/:weddingId/directory`

Gate: `weddingMember()` (any role — owner, editor, or viewer can browse).

Returns **live-only** (`listed = 'live'`) directory listings. Filters:

| Query param | Behaviour |
|---|---|
| `category` | Exact match against `directory_vendor_categories.category` (EXISTS subquery) |
| `q` | Case-insensitive substring match on `name` + `description` (LIKE with escaped wildcards) |
| `location` | Case-insensitive substring match on `location_text` |
| `limit` / `offset` | Pagination (`limit` clamped 1..50 default 24; `offset` ≥0; `total` count returned) |

Each listing in the response includes an `inWedding` boolean — `true` if a `vendors` CRM row already links this listing to the requesting wedding (i.e. it was already added via the `/add` endpoint below). The response includes organiser contact details (`email`, `phone`) from `directory_vendors`; they are displayed to the wedding's authenticated organisers.

Service: `directoryService.browse` in `cire/api/src/services/directory.ts`. Fail-soft: a DB error returns an empty result set rather than a 500.

### `POST /api/organiser/weddings/:weddingId/directory/:directoryVendorId/add`

Gate: `weddingEditor()` (owner or editor; viewers get 403).

Adds a directory listing to the wedding's Vendor CRM. The handler:

1. Reads the listing with `directoryService.getLiveListingById(listingId, weddingId)` — one statement that returns the listing, its categories and `inWedding`, the same "is this listing already in this wedding's CRM" EXISTS test browse makes. A missing or not-`live` listing returns 404 `listing_not_found` (draft listings cannot be added).
2. Validates the request body's `category` is one of the listing's categories (400 `invalid_category` otherwise). This check comes before the duplicate check, so a duplicate add with a wrong category is a 400.
3. Deduplication: `inWedding` true returns **409** `already_in_wedding` without trying the insert. The `vendors_wedding_directory_uniq` **partial unique index** (`UNIQUE (wedding_id, directory_vendor_id) WHERE directory_vendor_id IS NOT NULL`) catches a concurrent race; the route maps that `UNIQUE constraint` defect to the same **409** `already_in_wedding`.
4. Otherwise snapshots the listing's `name`, `email`, `phone` into a new `vendors` CRM row for the wedding under the chosen `category`, with `status = 'researching'`, `directory_vendor_id` linked, and `sort_order` one past the top of its status group (`vendorsService.create` reads that one row, not the group).

Routes in `cire/api/src/routes/vendor-directory.ts`.

---

## Deferred to later cycles

Still open. Directory browse used to sit in this list; it shipped 2026-07-18 and has its own section above.

- **Availability calendar** — `vendor_availability` per-day status; "available on your date" badge.
- **Enquiries** — `vendor_enquiries` + messages; quotes feed `budget_items.quoted_minor`; spam limiter.
- **Pricing estimates** — heuristic engine v1 (`services/pricing.ts` over `pricing-baselines.ts`); directory-informed v2 (median quoted amounts by category, k-anonymity floor ~5).
- **Budget / task / event linkage** — booking creates a `budget_items` row; ticks matching `tasks`; `events.venue_vendor_id`.
- **Date / location search** — filter by `vendor_availability` + radius from wedding's canonical geocode point.
- **Vendor moderation** — `suspended` state; cire admin tool.

---

## Related

- [[cire-auth]] — full auth model; organiser JWT verification chain; ARC bridge pattern
- [[cire-budget]] — budget items that vendor bookings will feed (deferred linkage)
- [[cire-checklist-tasks]] — tasks that vendor bookings will tick (deferred linkage)
- [[arc-tokens]] — ARC token pattern used by the `org:read` bridge
- [[compliance/data-map]] — vendor contact PII fields
- [[compliance/retention]] — vendor data retention rows
- [[production-deploy]] — §6.2 cire-api ARC key re-registration with `org:read`
