---
title: Subprocessor Register
tags: [compliance, gdpr, ccpa, soc2, vendor]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[ccpa]]"
  - "[[soc2]]"
  - "[[data-map]]"
  - "[[cire]]"
last-reviewed: 2026-06-11
---

# Subprocessor Register

Every third party that processes personal data on OSN's behalf, with the
contract status, data category, location, and review date. Required by
GDPR Art. 28 + CCPA + SOC 2 CC9.

**Maintenance rule:** every PR that adds a new third-party dependency
that touches personal data adds a row before merge. The
`/review-security` skill enforces this in the compliance checklist.

## Active processors

| Vendor | Service | Data category | Region | DPA on file? | SCC / adequacy basis | Last review | Risk |
|---|---|---|---|---|---|---|---|
| Cloudflare, Inc. | Cloudflare Email Service (transactional outbound) | Recipient email + message body (OTPs, security notices) | US | **TODO — sign Cloudflare DPA** | EU SCCs (template in DPA) | — | Medium — has email content. |
| Cloudflare, Inc. | Cloudflare DNS / TLS edge (planned for production) | IP, request metadata | US | Same DPA | EU SCCs | — | Low — transient. |
| Cloudflare, Inc. | Cloudflare D1 + R2 (`cire-sheets`) — cire wedding-invite store | **Guest PII at volume**: family names, guest names, RSVP status, **special-category dietary free-text (Art. 9)**, guest claim codes; raw organiser CSV uploads in R2 | US (account region — confirm D1/R2 location) | Same Cloudflare DPA | EU SCCs | — | **High — first persistent special-category store (dietary) + a separate DB Cloudflare now hosts as data store, not just edge. Confirm D1/R2 data-residency under the DPA.** |
| Pinterest, Inc. | `pinit_main.js` inspiration-board embed on the guest site (`@cire/web`) | IP, user-agent, and on-page behaviour of guests **who opt in** | US | **TODO — no Pinterest DPA / SCCs on file** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | — | Medium — consent-gated (opt-in, session-scoped) as of the prior commit; a plain-link fallback is always present so the embed is never required. No data reaches Pinterest until the guest consents. Until a DPA + transfer basis are on file, keep it opt-in only. |
| Komoot GmbH | Photon geocoder (Pulse address autocomplete) | Every keystroke + user IP | DE (EU) | **TODO — confirm DPA exists** | Adequacy (intra-EU) | — | **High — current implementation leaks keystrokes without consent (S-M13). Block until proxied + consent banner added.** |
| Grafana Labs | Grafana Cloud (logs / traces / metrics) | Trace attrs incl. profile_id; redacted logs; metric samples | US | **TODO — sign Grafana Labs DPA + SCCs** | EU SCCs | — | Medium — observability data with profile_id and ip_hash. |
| Redis provider (TBD — Upstash / Redis Cloud) | Rate-limit counters; rotated-session detection; auth state (Phase 4) | Hashed session tokens; IP-derived counters | TBD | **TODO — sign on choice** | EU SCCs if US-hosted | — | High — auth state. Pick EU region by default. |
| Supabase Inc. (planned migration target) | Production Postgres | Everything | EU region selectable | **TODO — sign at migration time** | Adequacy if EU region | — | Critical — primary data store. |
| Stripe (planned, Pulse ticketing) | Hosted checkout | Payment data (never touches OSN DB); customer email + name | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope. |

## Sub-subprocessors

Sub-processors of our processors (e.g. Cloudflare's hosting providers,
Grafana's underlying cloud). The DPAs require they be listed; we mirror
the vendor's published list and re-check quarterly.

- Cloudflare: see https://www.cloudflare.com/cloudflare-customer-subprocessors/
- Grafana Labs: see https://grafana.com/legal/subprocessors/
- Pinterest: see https://policy.pinterest.com/ (sub-processor list to confirm at DPA signing).
- (Add others as DPAs are signed.)

## Vendors we evaluated and rejected

| Vendor | Rejected because | Date |
|---|---|---|
| Sentry | Use Grafana Faro instead — same OTLP endpoint, fewer DPA surfaces | 2026-04 |
| (placeholder) | | |

## Per-vendor diligence checklist

When adding a new processor, run through this before merging the PR that
introduces them:

- [ ] DPA executed with Art. 28 + CCPA service-provider language
- [ ] SCCs in place if data leaves the EEA (or adequacy decision applies)
- [ ] DTIA filed under `wiki/compliance/dtia/<vendor>.md` if non-EU recipient (Schrems II)
- [ ] Vendor's published security posture reviewed (SOC 2 / ISO 27001 / pen-test report obtained)
- [ ] Sub-processor list URL documented in their row above
- [ ] Notification mechanism for sub-processor changes (≥30 days notice ideally)
- [ ] Breach notification SLA documented (we need ≤24 h to keep our own 72 h GDPR clock)
- [ ] Row added to [[data-map]] for the data class shared
- [ ] Row added to this register
- [ ] `/review-security` flags any feature using the vendor

## Vendor offboarding

When removing a processor:

- [ ] Confirm data deletion certificate (or contractual deletion within DPA's offboarding window)
- [ ] Update [[data-map]] to remove the recipient
- [ ] Move the row from "Active" to "Removed" below
- [ ] Notify users only if material change to privacy notice (e.g. region change)

## Removed processors

(Empty — record here when offboarding happens.)
