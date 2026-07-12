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
last-reviewed: 2026-07-10
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
| Resend (Plus Five Five, Inc.) | Resend HTTP API (transactional outbound — **live transport**, `api.resend.com/emails`) | Recipient email + message body (OTPs, security notices: passkey added/removed, recovery codes, cross-device login) | US | **TODO — sign Resend DPA** | **TODO — EU→US transfer basis (DPF self-cert or SCCs) to confirm before the `RESEND_API_KEY` secret is set in any EU-data env** | 2026-06-18 | Medium — has email content. Now the live transactional-email processor (supersedes Cloudflare Email Service). |
| Cloudflare, Inc. | Cloudflare Email Service (transactional outbound — **legacy fallback**, superseded by Resend) | Recipient email + message body (OTPs, security notices) | US | **TODO — sign Cloudflare DPA** | EU SCCs (template in DPA) | — | Medium — has email content. Used only if `RESEND_API_KEY` is absent. |
| Cloudflare, Inc. | Cloudflare DNS / TLS edge (planned for production) | IP, request metadata | US | Same DPA | EU SCCs | — | Low — transient. |
| Cloudflare, Inc. | Cloudflare D1 + R2 (`cire-sheets`) — cire wedding-invite store | **Guest PII at volume**: family names, guest names, RSVP status, **special-category dietary free-text (Art. 9)**, guest claim codes; raw organiser CSV uploads in R2 | US (account region — confirm D1/R2 location) | Same Cloudflare DPA | EU SCCs | — | **High — first persistent special-category store (dietary) + a separate DB Cloudflare now hosts as data store, not just edge. Confirm D1/R2 data-residency under the DPA.** |
| Pinterest, Inc. | `pinit_main.js` inspiration-board embed on the guest site (`@cire/web`) — **desktop only** | IP, user-agent, and on-page behaviour of **desktop** guests **who opt in** | US | **TODO — no Pinterest DPA / SCCs on file** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-06-19 | Medium — consent-gated (opt-in, page-wide persisted) **and desktop-only** as of `feat/pinterest-moodboard-ux`: touch / coarse-pointer devices never load the tracker at all (they get a plain link-out to Pinterest, no embed, no consent gate), so the transfer surface is now desktop + opt-in only. A plain-link fallback is always present on both paths so the embed is never required. No data reaches Pinterest until a desktop guest explicitly consents. Until a DPA + transfer basis are on file, keep it opt-in only. |
| Komoot GmbH | Photon geocoder (Pulse address autocomplete) | Every keystroke + user IP | DE (EU) | **TODO — confirm DPA exists** | Adequacy (intra-EU) | — | **High — current implementation leaks keystrokes without consent (S-M13). Block until proxied + consent banner added.** |
| Google LLC | Google Geocoding API — cire per-event venue lookup on the organiser Events tab (`cire/api`, server-side; platform Phase 0 PR 1) | The **organiser-provided event venue address only** (from their own events sheet) — one request per explicit "Look up" click, sent from the Worker (proxied — no browser-to-Google flow, no guest/organiser IP forwarded). Never guest data. | US | **TODO — sign Google Cloud DPA before setting `GOOGLE_GEOCODING_API_KEY` in prod** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm at key setup** | 2026-07-10 | Low — **key-optional + fail-soft**: no key ⇒ the endpoint answers `unavailable`, the location editor degrades to manual lat/lng entry, and nothing is sent to Google. Shipped inert until the key secret is set. Organiser-volunteered venue text only. |
| Grafana Labs | Grafana Cloud (logs / traces / metrics) | Trace attrs incl. profile_id; redacted logs; metric samples | US | **TODO — sign Grafana Labs DPA + SCCs** | EU SCCs | — | Medium — observability data with profile_id and ip_hash. |
| Redis provider (TBD — Upstash / Redis Cloud) | Rate-limit counters; rotated-session detection; auth state (Phase 4) | Hashed session tokens; IP-derived counters | TBD | **TODO — sign on choice** | EU SCCs if US-hosted | — | High — auth state. Pick EU region by default. |
| Upstash, Inc. | Upstash Redis (REST/HTTP) — edge-compatible Redis backend for `@osn/api` on Cloudflare Workers (the P2 backend in `@shared/redis`). Holds rotated-session family ids, ceremony/step-up `jti` state, recovery-lockout counters, and rate-limit keys (which incorporate HMAC-peppered IP hashes + account-derived keys). All **pseudonymised** — hashes, opaque ids, short-lived ceremony state; **no raw PII**. | Pseudonymised auth/rate-limit state: hashed session-family ids, step-up/ceremony jti, recovery-lockout counters, HMAC-peppered IP-hash + account-derived rate-limit keys | **`ap-southeast-2` (Sydney, Australia).** Chosen for AU data locality + latency — co-located with the D1 databases (`oc`/Sydney) and the Australian edge traffic, minimising RSVP/auth-write round-trips. | **TODO — sign at Phase-6 wiring (C-H5)** | AU-hosted, so EU/UK guest data would transit to AU — covered by the same consent/notice basis as the rest of the guest data (see [[gdpr]] "International transfers" + [[retention]]); not a new transfer concern for a pseudonymised cache. | — | High — auth/rate-limit state. **Introduced by the P2 backend; becomes active only when the Phase-6 Workers entry is wired + deployed — not on any live path yet.** Pseudonymised only. Region now locked (`ap-southeast-2`); DPA still to sign under C-H5. |
| Supabase Inc. (planned migration target) | Production Postgres | Everything | EU region selectable | **TODO — sign at migration time** | Adequacy if EU region | — | Critical — primary data store. |
| Stripe (planned, Pulse ticketing) | Hosted checkout | Payment data (never touches OSN DB); customer email + name | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope. |

### Link-outs (not processors)

User-initiated outbound links where no OSN-held personal data is transmitted on our behalf — no DPA required; listed to pre-answer the audit question:

- **Google Maps** — Pulse venue page "Open in Maps" builds a `google.com/maps/search` URL from the venue address; nothing loads until the user deliberately clicks, so no ePrivacy consent trigger. See [[venues]].

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
