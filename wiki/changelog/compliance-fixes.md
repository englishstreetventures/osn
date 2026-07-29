---
title: Compliance Fixes — Completed
tags: [changelog, compliance]
related:
  - "[[TODO]]"
  - "[[compliance/index]]"
  - "[[compliance/gdpr]]"
  - "[[compliance/retention]]"
  - "[[compliance/dpia/cire-guest-data]]"
  - "[[compliance/dsar]]"
last-reviewed: 2026-07-28
---

# Compliance Fixes — Completed

Archived closed compliance findings from the [[TODO]] Compliance Backlog.
Finding IDs use the `C-` prefix (see [[review-findings]]). For open findings
see the Compliance Backlog in [[TODO]]. The cire-internal `C-H2 (cire dietary)`
label disambiguates the cire dietary-consent finding from the root **C-H2**
(account erasure) — they share a number but are different findings.

## Closed findings

| ID | Finding | Standard | Resolution | Closed | Page |
|---|---|---|---|---|---|
| **C-H2** | Account-level erasure endpoints | GDPR Art. 17 | `DELETE /account` on osn-api (Flow A, full OSN delete) + pulse-api (Flow B, leave-Pulse). Step-up gated with new `purpose` claim, 7-day soft-delete tombstone, ARC fan-out to enrolled apps, hosted-event 14-day public cancellation window. New `app_enrollments` table. | 2026-04-27 | [[changelog/completed-features]] (account-deletion), [[compliance/dsar]] |
| **C-H2 (cire dietary)** | Special-category dietary free-text collected without a valid Art. 9(2)(a) consent affordance | GDPR Art. 9(2)(a) | PR #123: RSVP form shows an explicit, unticked opt-in checkbox once dietary text is entered and gates submit on it (links `/privacy`); API rejects (422) any non-empty dietary without consent; server-stamps a consent record `rsvps.dietary_consent_at` + `dietary_consent_version` (server-set `DIETARY_CONSENT_VERSION = "2026-06-17"`; migration `0012_dietary_consent.sql`). Lawful-processing blocker for the DPIA closed; residual C-H1 retention items remain. | 2026-06-17 | [[compliance/dpia/cire-guest-data]], [[compliance/data-map]] |
| **C-H4** | Privacy notice + Terms published at the point of collection | GDPR Art. 12-14 + CCPA notice-at-collection + DSA Art. 14 | PR #124: cire guest site publishes `/privacy` + `/terms` with a site-wide footer — Australia / APP framing, controller Aniket Chavan, DSAR contact owner@example.com, 1-year retention basis, processors (Cloudflare), guest rights, dietary/access free-text flagged as Art. 9 special-category collected under explicit consent. The parallel `@osn/landing` notice remains an open follow-up under the same ID. | 2026-06-17 | [[compliance/gdpr]], [[compliance/ccpa]], [[compliance/eprivacy]] |
| **C-M18 (Upstash region)** | Confirm Upstash region + GDPR Chapter V transfer basis before P6 deploy | GDPR Art. 44-49 | Region locked to **`ap-southeast-2` (Sydney)** — co-located with the D1 databases (`oc`/Sydney) + AU edge traffic for low RSVP/auth-write latency (AU-centric project). The P2 Redis backend holds only pseudonymised auth/rate-limit state, so AU hosting raises no new transfer concern: EU/UK guest data transiting to AU is covered by the same consent/notice basis as the rest of the guest data. DPA still to sign under C-H5. | 2026-06-18 | [[compliance/subprocessors]], [[compliance/gdpr]] |
| **C-H1 (oidc)** | Account hard-delete did not purge `oauth_consents` / `oauth_authorization_codes` | GDPR Art. 17 | Fixed in PR #315: `hardDeleteAccount`'s `commitBatch` deletes both tables by `account_id`; regression test seeds a consent + auth code and asserts both empty after `runHardDeleteSweep`. | 2026-07-24 | [[oidc-provider]], [[compliance/data-map]] |
| **C-H2 (oidc)** | OIDC personal-data surfaces missing from the Art. 30 records | GDPR Art. 30 | Data-map rows added for `oauth_consents`, `oauth_authorization_codes`, and the pairwise-`sub` derivation (per-sector HMAC over **profile id** — pseudonymous by design, salt permanent); retention rows added for both tables. Closed before any external third-party client is live (self-hosted clients only today). | 2026-07-24 | [[compliance/data-map]], [[compliance/retention]], [[oidc-provider]] |
| **C-M1 (oidc)** | DSAR export omitted the account's OIDC consents | GDPR Art. 15 | `GET /account/export` now streams an `oidc_consents` section (clientId, clientName via left-join, profileId, scope, grantedAt, revokedAt — revoked grants included as withdrawal history); section advertised in the header line; P6 invariant upheld (no accountId). Contract updated in [[compliance/dsar]]. | 2026-07-24 | [[compliance/dsar]], [[oidc-provider]] |
| **C-M2 (oidc)** | Expired-authorization-code retention enforced in code but absent from the schedule | GDPR Art. 5(1)(e) | Retention rows written: `oauth_authorization_codes` (60 s TTL, deleted on redemption, `runExpiredAuthCodeSweep` scheduled reap, also purged on consent revoke + account erasure); `oauth_consents` (until account deletion or explicit withdrawal; revoked rows kept as the withdrawal record). | 2026-07-24 | [[compliance/retention]], [[oidc-provider]] |
| **C-M3 (oidc)** | Art. 7(3) — withdrawing an app's authorization must be as easy as granting it | GDPR Art. 7(3) | `DELETE /oidc/connections/:clientId` (access-token authed, rate-limited) revokes the consent AND deletes any authorization code in flight for the pair, so withdrawal is effective immediately — not after the 60 s code window drains. `GET /oidc/connections` lists live grants (client name/logo, profile, scope, granted-at). The settings-screen surface remains open as **C-M3-ui (oidc)**. | 2026-07-24 | [[compliance/gdpr]], [[oidc-provider]] |
| **C-L33** | Browser-loaded Google Fonts sent visitor IP + UA to Google LLC (US) on every cire page view with no subprocessor row (cf. LG München I 3 O 17493/20) | GDPR Art. 28 + Art. 44-49, ePrivacy | **Flow deleted, not papered**: Cormorant Garamond + Lato are self-hosted via Fontsource on all four cire surfaces (`cire/web` incl. legal + 404, `cire/organiser`, `cire/vendor`, `cire/landing`) — hashed same-origin `/_astro/*` assets, latin + latin-ext, `font-display: swap` preserved. The `fonts.googleapis.com` / `fonts.gstatic.com` preconnects and CSP allowances are removed (guest-site CSP test now asserts their ABSENCE). Reconciled with the site-wide consent framework (#329, which had declared Google Fonts its one ungated vendor): the `google-fonts` consent-vendor entry is deleted, `CONSENT_POLICY_VERSION` bumped to `2026-07-30`, the `/privacy` owner-note replaced, and the subprocessor row #329 added is retired to Removed processors (Fonts half of C-M20). The osn/pulse landings still use Google Fonts — open as C-L34. | 2026-07-30 | [[compliance/subprocessors]], [[apps/cire]] |

## Partial closes still tracked open

- **C-H1 (cire retention)** — narrowed this session: the
  expired-guest-session sweep (PR #127) and the 1-year guest-data sweep
  (PR #132, `rsvps` / `guests` / `families` / `imports` DB rows) now run on a
  daily Cloudflare cron. The remaining open item is sweeping the **R2 objects**
  (raw `cire-sheets` CSVs) referenced by swept `imports` rows. See
  [[compliance/retention]].
- **C-H4 (osn-landing)** — the cire guest-site notice shipped (above); the
  `@osn/landing` privacy notice + cookie/storage inventory + sale/share
  declaration are still pending. See [[compliance/eprivacy]], [[compliance/ccpa]].
