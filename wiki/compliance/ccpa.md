---
title: CCPA / CPRA + State Privacy Laws
tags: [compliance, ccpa, privacy, us-state]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[dsar]]"
  - "[[data-map]]"
  - "[[scope-matrix]]"
last-reviewed: 2026-04-26
---

# CCPA / CPRA

The CCPA + CPRA apply to OSN once we hit any of the thresholds:

- $25M annual gross revenue, OR
- buy / receive / sell / share personal information of ≥100,000 California consumers, OR
- derive ≥50% of revenue from selling / sharing California consumers' personal information.

We will hit threshold #2 long before #1 or #3 (consumer social network). We
build the surface now to avoid retrofit.

## Differences from GDPR (deltas to implement)

| GDPR | CCPA delta | Our action |
|---|---|---|
| 30-day DSAR response | 45 days (extendable +45) | Single endpoint, conservative 30-day target satisfies both. |
| Right of erasure | Right to delete (similar; consumer cannot demand erasure of data needed for transactions) | Same `DELETE /account` covers it; document the legitimate-business retention exception. |
| No "do not sell" concept | Mandatory "Do Not Sell or Share My Personal Information" link if processing covered consumers | Add link in `@osn/landing` footer + every app's privacy menu. We don't sell, but the link is mandatory. |
| Special-category data | "Sensitive Personal Information" — geolocation precise (<1850m), genetic, biometric (used to identify), health, sexual orientation, race, religion, account credentials, contents of mail / messages | Surface "Limit the Use of My Sensitive Personal Information" link. **Note:** passkey *public keys* are NOT biometric SPI under §1798.140(ae) — biometrics never leave the authenticator (see [[passkey-primary]]). Re-evaluate only if we ever store server-side biometric templates (we do not). |
| Children — explicit consent for special-category | Opt-in (not opt-out) for sale/share if user known to be 13–16; parental consent under 13 | COPPA gate (no under-13) handles it; add 13–15 opt-in if we ever sell/share (we won't). |
| Authorised representative | Authorised agent with notarised authority can submit on user's behalf | Build into [[dsar]] runbook; verify via signed power-of-attorney before action. |
| No financial-incentive concept | Service-quality differential / financial incentive disclosure if offering loyalty / discount in exchange for data | N/A today; flag if we ever do. |
| No record-keeping concept | Maintain DSAR + opt-out request log for 24 months | Same audit log as [[dsar]]. |

## Other US state privacy laws

The CCPA-shaped surface satisfies most of these. As of 2026 the active
ones, with their notable deltas, are:

| State | Law | Threshold trigger | Notable delta |
|---|---|---|---|
| Virginia | VCDPA | 100k consumers OR 25k consumers + 50% revenue from sale | "Sensitive data" requires opt-in (vs CCPA opt-out). |
| Connecticut | CTDPA | Same as VCDPA | Universal opt-out signal recognition (Global Privacy Control). |
| Texas | TDPSA | Conducts business in TX + processes PI of TX residents (no number threshold; small-biz exemption only) | SDK / advertising disclosure if collecting PI for targeted ads. |
| Colorado | CPA | 100k consumers OR 25k + revenue | Universal opt-out signal mandatory by Jan 2025. |
| Utah | UCPA | $25M revenue + 100k consumers | Narrowest; no rectification right. |
| Oregon | OCPA | 100k OR 25k+revenue | Right to a list of specific third parties (vs categories elsewhere). |
| Iowa, Delaware, Florida, Tennessee, Indiana, Montana, NH, NJ, MN, RI | Various | Various | Mostly VCDPA-shaped. Differences captured in DSAR runbook. |

**Operational consequence:** treat universal opt-out signals (Global
Privacy Control browser header, Sec-GPC: 1) as a CCPA opt-out from sale /
share. Implementation: `@osn/api` middleware reads `Sec-GPC: 1`, sets a
`gpc_opt_out` flag on the session, persisted to a `consent_signals` table
when the consent-records system lands (C-L1).

## Project changes required

Tracked with `C-` IDs:

1. **"Do Not Sell or Share" + "Limit Use of SPI" footer links** on `@osn/landing`. Stub pages explain we do not sell/share. ID: **C-M9**.
2. **Authorised-agent verification** in DSAR runbook. ID: rolled into **C-M1**.
3. **Global Privacy Control header recognition** middleware. ID: **C-L7**.
4. **CCPA-shaped DSAR audit log** persisted for 24 months. ID: rolled into **C-M1**.
5. **Sale / share = "no"** declaration in privacy notice (negative declaration is sufficient if accurate). ID: rolled into **C-H4**.

## What "sale" and "share" mean here

CCPA's definitions are wider than common usage:

- **Sale** = exchanging personal information for monetary or other valuable consideration. We do not.
- **Share** = disclosing personal information for cross-context behavioural advertising. We do not — no third-party ad networks anywhere in the stack today. Adding one (e.g. a "promoted events" network for Pulse) flips both definitions; revisit before that ships.

Subprocessors transferring data to perform a contracted service (Cloudflare
Email, Photon, Grafana Cloud) are **service providers**, not "sales", *if*
the contract restricts them appropriately. The DPAs in [[subprocessors]]
must contain CCPA service-provider language alongside GDPR Art. 28
language — most templates from those vendors already do.
