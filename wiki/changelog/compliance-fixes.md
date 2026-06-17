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
last-reviewed: 2026-06-17
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

## Partial closes still tracked open

- **C-H1 (cire retention)** — substantially narrowed this session: the
  expired-guest-session sweep (PR #127) and the 1-year guest-data sweep
  (PR #132, `rsvps` / `guests` / `families` / `imports` DB rows) now run on a
  daily Cloudflare cron. The remaining open item is reaping the **R2 objects**
  (raw `cire-sheets` CSVs) referenced by swept `imports` rows. See
  [[compliance/retention]].
- **C-H4 (osn-landing)** — the cire guest-site notice shipped (above); the
  `@osn/landing` privacy notice + cookie/storage inventory + sale/share
  declaration are still pending. See [[compliance/eprivacy]], [[compliance/ccpa]].
