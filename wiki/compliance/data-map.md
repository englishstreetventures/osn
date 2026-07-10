---
title: Data Map (Article 30 Records of Processing)
tags: [compliance, gdpr, data-map, ropa]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[retention]]"
  - "[[subprocessors]]"
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[dpia/cire-guest-data]]"
last-reviewed: 2026-07-10
---

# Data Map

The Article 30 Record of Processing Activities. Every personal-data field
in OSN, the purpose it serves, the lawful basis for processing it, the
recipients, the retention window, and the system page that owns it.

**Maintenance rule:** every PR that introduces a new personal-data field
adds a row before merge. The `/review-security` skill enforces this in
the compliance checklist.

## Format key

- **Field** — DB column or in-flight form name (camelCase / snake_case as in code).
- **Purpose** — concrete reason we need it. "Account management" is too vague — say "issuing tokens for the authenticated session".
- **Lawful basis** — Art. 6(1) letter (a consent / b contract / c legal / d vital / e public / f legitimate interests). For special-category, also Art. 9(2).
- **Retention** — link to [[retention]] row.
- **Recipients** — internal services + named third parties.
- **System page** — wiki link.

## Identity (`@osn/api` — `accounts`, `users`, `passkeys`, `sessions`, `security_events`, `recovery_codes`, `email_changes`)

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| `accounts.email` | Login identifier; OTP destination for step-up + email change | Art. 6(1)(b) — contract | While account active + 30 d soft-delete tombstone | `@osn/api` only; **Resend** for outbound mail (processor; Cloudflare Email Service is a legacy fallback) | [[identity-model]], [[email]] |
| `accounts.passkeyUserId` | WebAuthn `user.id` opaque to prevent cross-profile correlation | Art. 6(1)(b) | While account active | `@osn/api` only | [[identity-model]] |
| `accounts.maxProfiles` | Per-account profile cap | Art. 6(1)(b) | While account active | `@osn/api` only | [[identity-model]] |
| `users.handle` | Public identifier | Art. 6(1)(b) | While profile active; tombstoned on delete (30 d) | All services + public web | [[identity-model]] |
| `users.displayName` | Public name | Art. 6(1)(b) | Same | Same | [[identity-model]] |
| `users.avatarUrl` | Public avatar | Art. 6(1)(b) | Same | Same | [[identity-model]] |
| `passkeys.credentialId` | WebAuthn credential lookup | Art. 6(1)(b) | While passkey enrolled | `@osn/api` only | [[passkey-primary]] |
| `passkeys.publicKey` | Verify WebAuthn assertions | Art. 6(1)(b) | Same | `@osn/api` only | [[passkey-primary]] |
| `passkeys.label` | UX — "iPhone 15 Pro" | Art. 6(1)(b) | Same | `@osn/api` only | [[passkey-primary]] |
| `passkeys.aaguid`, `backup_eligible`, `backup_state` | UX — show "synced" badge | Art. 6(1)(f) — legit interest in helpful UX | Same | `@osn/api` only | [[passkey-primary]] |
| `passkeys.last_used_at` | UX — "Last used 2 days ago" | Art. 6(1)(f) | Same | `@osn/api` only | [[passkey-primary]] |
| `sessions.id` (= SHA-256 of token) | Session validation | Art. 6(1)(b) | 30 d sliding | `@osn/api` only | [[sessions]] |
| `sessions.ua_label` | Coarse "Firefox on macOS" for the user-facing sessions list | Art. 6(1)(b) | 30 d sliding | `@osn/api` only | [[sessions]] |
| `sessions.ip_hash` (HMAC-SHA256 with pepper) | Anomaly detection; user-facing sessions list | Art. 6(1)(f) — legit interest in fraud detection | 30 d sliding | `@osn/api` only | [[sessions]] |
| `sessions.last_used_at` | UX | Art. 6(1)(f) | 30 d sliding | `@osn/api` only | [[sessions]] |
| `security_events.kind` + `metadata` | Audit trail of security-relevant actions | Art. 6(1)(c) — legal obligation under GDPR Art. 32; Art. 6(1)(f) | 12 months then purge | `@osn/api`; user via `/account/security-events` | [[recovery-codes]] |
| `recovery_codes.code_hash` | Account recovery | Art. 6(1)(b) | While account active | `@osn/api` only | [[recovery-codes]] |
| `recovery_codes.used_at` | Single-use enforcement; security-event reasoning | Art. 6(1)(c)+(f) | While account active | `@osn/api` only | [[recovery-codes]] |
| `email_changes` audit | Anti-abuse cap (2/7d) + audit | Art. 6(1)(c)+(f) | 90 d | `@osn/api` only | [[identity-model]] |
| `cdl_requests.cdl_secret_hash` | Cross-device login secret | Art. 6(1)(b) | 5 min TTL | `@osn/api` only | [[sessions]] |

## Social graph (`@osn/api` — `connections`, `blocks`, `organisations`, `organisation_members`)

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| `connections.requesterId`, `addresseeId`, `status` | Social graph edges | Art. 6(1)(b) | While both profiles active | `@osn/api`; `@pulse/api` via ARC for friends-attending discovery; `@zap/api` via ARC for blocked-user filter | [[social-graph]] |
| `blocks.blockerId`, `blockedId` | Block enforcement | Art. 6(1)(b)+(f) | While blocker active | `@osn/api` + ARC consumers | [[social-graph]] |
| `organisations.handle`, `name` | Public org identity | Art. 6(1)(b) | While org active | All services + public web | [[identity-model]] |
| `organisations.ownerId` | Permission boundary | Art. 6(1)(b) | While org active | `@osn/api` only | [[identity-model]] |
| `organisation_members.profileId`, `role` | Membership + permissions | Art. 6(1)(b) | While membership active | `@osn/api` + member-only views | [[identity-model]] |

## Pulse (`@pulse/api` — `events`, `event_rsvps`, `event_series`, `pulse_users`, `pulse_close_friends`, `event_comms`, `venues`, `event_lineup`)

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| `events.title`, `description`, `startTime`, `endTime`, `location` (lat/lng + free text) | Event listing | Art. 6(1)(b)+(f) | While event active + 90 d after end (host control) | `@pulse/api` + visibility-gated consumers; ICS export | [[event-access]] |
| `events.createdByProfileId` | Host attribution | Art. 6(1)(b) | Same | Same | [[event-access]] |
| `events.attendanceVisibility` | Privacy control | Art. 6(1)(a) — explicit consent for the choice | Same | `@pulse/api` only | [[event-access]] |
| `event_rsvps.profileId`, `status` (going/interested/not_going) | RSVP tracking | Art. 6(1)(b) | While event active + 90 d | Visibility-gated | [[event-access]] |
| `event_rsvps.shareSourceFirst` / `shareSourceLast` (+ `*SeenAt`) | Share attribution — which platform (instagram/facebook/tiktok/x/whatsapp/copy_link/other) the attendee discovered the event through, first- and last-touch | Art. 6(1)(f) — legitimate interest. Balancing note: value is a **platform name only**, never a third-party identifier, cookie, or cross-site token; the attendee is not tracked off-platform; data is visible to the organiser of *this* event only. Organiser self-RSVPs are excluded. | Deleted alongside the parent RSVP row (while event active + 90 d) | Organiser of the event only (via planned attribution analytics) | [[event-access]] |
| **Indirect special-category** — events that reveal health, sexuality, religion, politics by topic | Same as above | Art. 9(2)(e) — manifestly made public by data subject (the host) — but RSVP'ing reveals it about the attendee, who has *not* manifestly made it public. **Treat with extra care: explicit consent banner on RSVP for events tagged with sensitive categories.** | Same | Same | [[event-access]] |
| `pulse_close_friends.profileId`, `friendId` | Pulse-scoped close friends list | Art. 6(1)(b) | While both profiles active | `@pulse/api` only | [[pulse-close-friends]] |
| `pulse_users.interests` (planned) | Personalisation | Art. 6(1)(a) — opt-in via onboarding | While account active; user-resettable | `@pulse/api` only | TODO row |
| `event_comms.recipientProfileId`, `kind` (email/sms), `payload` | Host-to-attendee comms log | Art. 6(1)(b) — event service contract | 90 d | `@pulse/api` + comms providers (planned) | TODO row |
| `venues.instagram_handle`, `website_url`, `address` + lat/lng | Public venue contact/location — identifies a person for sole-trader venues | Art. 6(1)(f) — legit interest in public business listings | While venue listed; removed on org request | `@pulse/api` + public web (anonymous venue pages) | [[venues]] |
| `event_lineup.artist_name` | Publicly billed performer names (incl. stage names of natural persons) | Art. 6(1)(f) — performance publicly billed by the host | While parent event retained (event + 90 d) | `@pulse/api` + public web via lineup endpoint | [[venues]] |

## Zap (`@zap/api` — planned: `chats`, `chat_members`, `messages`, `org_chats`, `org_agents`, `localities`, `locality_subscriptions`)

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| `messages.ciphertext` | Message body, E2E-encrypted | Art. 6(1)(b) | Per chat-level disappearing-message setting (default: indefinite) | `@zap/api` storage; participants only can decrypt | [[zap]] |
| `messages.senderProfileId`, `chatId`, `createdAt` | Routing + ordering | Art. 6(1)(b) | Same | `@zap/api` storage | [[zap]] |
| `chat_members.profileId` | ACL | Art. 6(1)(b) | While membership active | `@zap/api` storage | [[zap]] |
| `org_chats` transcripts (M3) | Customer support | Controller = the org. OSN is **processor** under DPA. Lawful basis is the org's responsibility; we provide the technical means. | Per org's retention setting; default 24 months | Org agents; the consumer who initiated; `@zap/api` storage | [[zap]] |
| `org_agents.profileId`, `orgId`, `role` | Agent assignment | Art. 6(1)(b) | While employed | `@zap/api` + org admin | [[zap]] |
| `localities` + `locality_subscriptions` (M4) | Locality-broadcast routing | Art. 6(1)(a) — opt-in | User-resettable | `@zap/api` + locality-org broadcasters | [[zap]] |

## Cire (`@cire/api` — wedding invites, separate Cloudflare D1 + R2)

Cire is a wedding-invite app merged into the monorepo as the `cire/*`
workspace. It runs its **own** Cloudflare D1 and R2, separate from `osn/db`
(see [[cire]], [[cire-auth]]). The **controller** for guest data is the
wedding organiser (the couple) who uploads the guest list; OSN/cire is the
**platform / processor** providing the technical means. The wedding owner
is identified by `weddings.owner_osn_profile_id` — an opaque OSN profile id
(`usr_*` string, cross-DB reference, **no FK**). Lawful basis is
organiser-initiated wedding administration.

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| `families.family_name` | Guest household label on the invite + organiser guest table | Art. 6(1)(f) — legit interest in wedding administration (organiser-controlled) | Tied to wedding lifecycle — no automated purge yet (C-H1) | `@cire/api` + the wedding owner (organiser) | [[cire-auth]] |
| `families.public_id` (claim CODE, e.g. `SHARMA-IVY-QM42`) | **Credential** — exchanged at `POST /api/claim` for a guest session; not a public identifier | Art. 6(1)(b) — contract (the access mechanism for the guest's RSVP) | Tied to wedding lifecycle (C-H1) | `@cire/api` only (treated as a secret — redacted in logs, C-M2) | [[cire-auth]] |
| `families.public_id` where `kind = 'host'` (host preview CODE, `HOST-*`) | **Credential** — organiser-provisioned code that opens the guest invite to see every event ("Preview invite"). Synthetic host family carries no real guest personal data (one placeholder member "Wedding Host"); preview-only, cannot RSVP | Art. 6(1)(f) — wedding administration (organiser self-service preview) | Tied to wedding lifecycle (C-H1) | `@cire/api` only (treated as a secret — redacted via the `publicId`/`public_id` deny-list) | [[cire-auth]] |
| `guests.first_name`, `last_name` | Per-guest identity on the invite + RSVP attribution | Art. 6(1)(f) — wedding administration (organiser-controlled) | Tied to wedding lifecycle (C-H1) | `@cire/api` + wedding owner | [[cire-auth]] |
| `families.code_shared_at`, `first_opened_at`, `deactivated_at` (invite-tracking timestamps) | Organiser invite-delivery tracking — drives the dashboard's Sent/Opened badges + Deactivated state and the `guests.csv` roster export. `first_opened_at` is behavioural (when a guest household first opened the invite; host-preview claims excluded) | Art. 6(1)(f) — wedding administration (organiser-controlled) | Tied to wedding lifecycle — covered by the 1-year `sweepExpiredGuestData` families sweep, see [[retention]] (C-H1 for the R2 side) | `@cire/api` + wedding owner/co-hosts (dashboard + CSV export) | [[cire-auth]] |
| `rsvps.status` (attending/declined/pending) | RSVP tracking for the organiser | Art. 6(1)(f) — wedding administration | Tied to wedding lifecycle (C-H1) | `@cire/api` + wedding owner | [[cire-auth]] |
| `rsvps.dietary` (FREE TEXT) | Cater for dietary needs | **Special-category — Art. 9(2)(a) explicit consent.** Free text reveals religion (halal/kosher) + health (allergies/coeliac). Consent affordance + consent-record capture at the RSVP form **IMPLEMENTED — C-H2 (cire dietary), PR #123**: unticked opt-in checkbox, API 422s any non-empty dietary without consent, server-stamped consent record. Underlying Art. 6 basis: Art. 6(1)(a) consent. | Tied to wedding lifecycle; **1-year sweep now enforced (PR #132)** — see [[retention]]. R2 follow-up still open (C-H1) | `@cire/api` + wedding owner | [[cire-auth]], [[dpia/cire-guest-data]] |
| `rsvps.dietary_consent_at`, `rsvps.dietary_consent_version` (consent record) | Evidence the Art. 9(2)(a) explicit consent for the dietary field (who/when/which copy version) | Art. 9(2)(a) — the consent record itself; necessary for accountability (Art. 5(2)). Server-stamped (`dietary_consent_version` default `"2026-06-17"`); migration `0012_dietary_consent.sql` | Cascades with the parent `rsvps` row (1-year sweep, PR #132) | `@cire/api` + wedding owner | [[dpia/cire-guest-data]] |
| `sessions` (SHA-256 hash of `cire_session` token) | Guest session validation after claim; gates `/api/rsvp` | Art. 6(1)(b) — contract | 30-day cookie TTL; **expired rows now swept daily (PR #127 scheduled handler + `session.ts` sweep, `cire.session.swept` metric)** | `@cire/api` only | [[cire-auth]] |
| `guest_account_links.osn_account_id`, `osn_profile_id` (+ `guest_id`/`family_id`/`wedding_id`) | **Cross-database linkage** — binds a cire household invitee (`guests` row) to a real OSN/Pulse account so the invitation can be surfaced inside Pulse and the linked invitee can (with their household) see family members' RSVPs. `osn_account_id` is the OSN *account* principal resolved server-to-server over ARC from the access token's profile id; `osn_profile_id` records which profile performed the link (audit only). Opt-in + additive — the family claim-code session stays the primary guest credential. | Art. 6(1)(a) — **consent / opt-in** (the guest explicitly links their own account via the dual-credential `POST /api/account/link`, which requires BOTH a valid guest session AND an OSN access token). | Tied to wedding lifecycle — **`ON DELETE cascade`** from `guests`/`families`/`weddings` covers guest/family/wedding erasure (incl. the 1-year guest-data sweep, which deletes the parent `guests` row). **`osn_account_id`/`osn_profile_id` are opaque cross-DB references with NO foreign key** (cire's D1 ≠ osn's D1), so an **OSN-side account deletion does NOT fan out to cire** — the link row is orphaned (holds a stale `osn_account_id` that resolves to a deleted account). See the orphan note below + [[dsar]] (C-M1). | `@cire/api` + the wedding owner; the linked `osn_account_id` is shared with `@pulse/api` (planned invitation-surfacing) | [[cire-auth]] |
| `imports` table rows (organiser spreadsheet import metadata + parsed guest/event data) | Bulk guest-list onboarding | Art. 6(1)(f) — wedding administration | **Retained indefinitely, including across reverts — no purge (C-H1)** | `@cire/api` + wedding owner | [[cire]] |
| R2 `imports/<id>/{events,guests}.csv` (raw organiser uploads) | Source-of-truth for re-import / audit of an import | Art. 6(1)(f) — wedding administration | **Retained indefinitely, including across reverts — no lifecycle/TTL (C-H1)** | `@cire/api` (R2 bucket `cire-sheets`) + wedding owner | [[cire]] |
| `wedding_invite_customisations` text (hero/story/events-header copy, couple names, welcome greeting) | Organiser-authored invite presentation copy (invite builder) | Art. 6(1)(f) — wedding administration (organiser-controlled) | Tied to wedding lifecycle — D1 `ON DELETE cascade` from `weddings` (C-H1) | `@cire/api` + wedding owner + **public guest site** (rendered on the invite) | [[cire]] |
| R2 `assets/<weddingId>/<slot>-<uuid>` invite images (hero/story **photos**) | Organiser-uploaded invite imagery (invite builder) | Art. 6(1)(f) — wedding administration | **Retained indefinitely — the D1 row's cascade does NOT reach R2; only best-effort delete on re-upload/remove; no lifecycle/sweeper (C-H1 / IB-S-L2)** | `@cire/api` (R2 bucket `cire-assets`) + **public guest site** | [[cire]] |

**Controller / processor note.** For guest data the organiser is the
controller (they decide to upload the list, set the field contents); cire
is the processor. The organiser is themselves an OSN data subject (their
`owner_osn_profile_id` ties the wedding to an OSN account — see
[[identity-model]]). DSAR reachability + the cross-DB deletion orphan are
covered in [[dsar]] (C-M1).

**Account-link orphan note (AL-C-L1).** `guest_account_links` is the only
cire→OSN *personal-data* edge that points at an OSN principal. It cascades
cleanly on the **cire** side (deleting the guest / family / wedding, or the
1-year guest-data sweep, removes the link row via `ON DELETE cascade`). It does
**not** cascade on the **OSN** side: `osn_account_id` / `osn_profile_id` are
opaque strings with no foreign key (separate databases), so deleting the OSN
account leaves the cire link row in place holding a now-stale account id. The
accepted behaviour today is **orphan-tolerant** — a stale link surfaces no
OSN-side personal data (cire stores only the opaque id, never name/email), and
the next ARC resolve of a deleted account simply fails closed (the invitation
just stops surfacing in Pulse). A reverse ARC fan-out from OSN account-deletion
into cire is **deferred** (cire exposes no inbound ARC purge route today). Folds
into [[dsar]] (C-M1).

**Age-gate note (C-L1).** The guest flow is **family/household-mediated** —
claim codes are issued to households by the organiser, and the guest site is
a general-adult-audience wedding page (no signup, no DOB collection). There
is no direct child-account creation surface. Guest age handling folds into
the platform-wide age-gate rollout when it lands ([[coppa]] C-H8); no
cire-specific gate is required in the interim. Light-touch by design.

## Observability (`@shared/observability` → Grafana Cloud)

| Field | Purpose | Lawful basis | Retention | Recipients | System page |
|---|---|---|---|---|---|
| Trace span attributes (route, method, status, profile_id) | Debugging + perf monitoring | Art. 6(1)(f) | 14 d (Grafana free tier) | Grafana Labs (US — needs SCC + DPA) | [[observability/overview]] |
| Log entries (Effect.log*) — redacted | Debugging + audit | Art. 6(1)(f) | 50 GB rolling (~30 d typical) | Grafana Labs | [[observability/overview]] |
| Metric samples (low cardinality) | Dashboards | Art. 6(1)(f) | 30 d (Grafana free tier metrics retention) | Grafana Labs | [[observability/overview]] |
| Frontend Faro events | UX + error monitoring | Art. 6(1)(f) — must remain non-PII; otherwise consent required | 14 d | Grafana Labs | [[observability/overview]] |

## Cross-cutting

| Field | Purpose | Lawful basis | Retention | Recipients |
|---|---|---|---|---|
| Outbound email (OTP, security notice) | Transactional auth | Art. 6(1)(b) | Resend retains delivery logs per their DPA | **Resend (US)** — live transport; Cloudflare Email Service (US) is a legacy fallback |
| Geocoder query (Pulse) | Convert typed address → coordinates | Currently no consent — **outstanding compliance gap (S-M13)** | Not retained by us; Photon retains per their policy | Photon (Komoot, Germany) |
| Visitor IP-derived coarse location — `request.cf` city/region/country (Pulse **marketing** site) | Show the visitor's approximate "what's on near you" area on the `@pulse/landing` hero + route its CTA to the nearest city | Art. 6(1)(f) — legit interest in a relevant landing page (coarse, city-level only) | **Not retained** — computed per request at the Cloudflare edge, never stored, no cookies | `@pulse/landing` Pages Function (`/api/geo`) → the visitor's own browser only; no third party. See [[pulse-landing]] |

## Things we explicitly do NOT collect

- Phone numbers (no SMS-OTP; recovery codes replace it).
- Passwords (passkey-primary).
- Real names beyond `displayName` (user-supplied, optional).
- Date of birth (will collect for COPPA gate; rejected DOB not retained).
- Government ID (Zap M3 trader verification will collect from orgs only, never end users).
- Payment card data (Stripe-hosted when ticketing lands; never touches our DB).
- Third-party advertising IDs (we run no ads).
- Behavioural-analytics events (no third-party analytics today).
- Precise device fingerprints beyond what WebAuthn requires.

When this list shrinks, add the new field to a Data Map row above.
