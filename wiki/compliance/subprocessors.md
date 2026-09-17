---
title: Subprocessor Register
tags: [compliance, gdpr, ccpa, soc2, vendor]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[ccpa]]"
  - "[[soc2]]"
  - "[[data-map]]"
  - "[[retention]]"
  - "[[access-control]]"
  - "[[cire]]"
  - "[[cire-registry]]"
last-reviewed: 2026-09-14
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
| Resend (Plus Five Five, Inc.) | Resend HTTP API (transactional outbound — **live transport**, `api.resend.com/emails`) | Recipient email + message body (OTPs, security notices: passkey added/removed, recovery codes, cross-device login; **vendor claim-invite emails from cire-api with vendor sole-trader email address**) | US | **TODO — sign Resend DPA** | **TODO — EU→US transfer basis (DPF self-cert or SCCs) to confirm before the `RESEND_API_KEY` secret is set in any EU-data env** | 2026-07-17 | Medium — has email content. Now the live transactional-email processor (supersedes Cloudflare Email Service). Senders: osn-api (security notices), cire-api (claim invites). |
| Cloudflare, Inc. | Cloudflare Email Service (transactional outbound — **legacy fallback**, superseded by Resend) | Recipient email + message body (OTPs, security notices) | US | **TODO — sign Cloudflare DPA** | EU SCCs (template in DPA) | — | Medium — has email content. Used only if `RESEND_API_KEY` is absent. |
| Cloudflare, Inc. | Cloudflare DNS / TLS edge (planned for production) | IP, request metadata | US | Same DPA | EU SCCs | — | Low — transient. |
| Cloudflare, Inc. | Cloudflare D1 + R2 (`cire-sheets`) — cire wedding-invite store | **Guest PII at volume**: family names, guest names, RSVP status, **special-category dietary free-text (Art. 9)**, guest claim codes; raw organiser CSV uploads in R2 | US (account region — confirm D1/R2 location) | Same Cloudflare DPA | EU SCCs | — | **High — first persistent special-category store (dietary) + a separate DB Cloudflare now hosts as data store, not just edge. Confirm D1/R2 data-residency under the DPA.** |
| Pinterest, Inc. | `pinit_main.js` inspiration-board embed on the guest site (`@cire/invites`) | IP, user-agent, and on-page behaviour of guests who have not switched off third-party content | US | **TODO — no Pinterest DPA / SCCs on file** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — governed by the site-wide `embeds` category (`[[cire-consent]]`), which is **opt-OUT**: the embed loads for a guest who has not decided, and the banner names Pinterest and offers the off switch on first visit. Withdrawable at any time from a standing footer control, and a refusal is honoured permanently. **This is a deliberate departure from prior consent** — see the consent page for the reasoning and the one-field reversal. `<ConsentGate>` does not render the embed while consent is absent, so the tracker is never injected. A plain outbound link to the board is always present, so refusing costs the guest nothing. **The prior desktop-only split is gone** (removed when the mobile embed was re-enabled) — the gate, not the device, is now the control. **C-H12 (open, 2026-07-29):** this row previously read "keep it opt-in only" — that control was removed when `embeds` moved to opt-out, so the tracker now fires on first visit for an undecided guest while both the DPA and the transfer-basis cells are still open. Recorded here as an accepted, un-approved risk rather than left as a claim the code contradicts. Reverting is one field (`CATEGORY_META.embeds.defaultGranted` in `cire/invites/src/lib/consent/categories.ts`); the decision needs a named approver and a date, or that flip. |
| Google LLC | Google Maps Embed API `place` iframe on the guest site (`@cire/invites` `MapPreview`) — venue map inside the event-details sheet | IP + user-agent of guests who have not switched off third-party content; the venue address is in the iframe URL. Referrer trimmed to origin (S-L2) so the slug-/`?code=`-bearing invite path is never sent. | US | **TODO — sign Google Cloud DPA** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — **brought under the consent framework 2026-07-29**; previously loaded for every guest with a venue address and offered no way to stop it. Now behind the same **opt-out** `embeds` category as Pinterest — still on by default, but disclosed on the banner, listed in the privacy notice, and switchable off, falling back to the self-contained CSS map card (no network request). Also key-optional: with no `PUBLIC_GOOGLE_MAPS_EMBED_KEY` the iframe never renders. |
| Google LLC | Google Fonts (`fonts.googleapis.com` stylesheet + `fonts.gstatic.com` woff2) on the guest site (`@cire/invites`) | IP + user-agent of **every** guest | US | **TODO — sign Google Cloud DPA** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — **the one third party the consent gate does NOT cover**: the font `<link>` is in the `<head>` of the server-rendered document, so it is requested before any choice can apply. Declared `enforcement: "always"` in the vendor registry and disclosed as "loads on every visit" in both the preferences dialog and `/privacy` rather than implied to be covered. **Remediation is removal, not gating** — self-host the two woff2 families and this row disappears; tracked as an open issue in `xchromo/osn` (`label:product:cire`). |
| Komoot GmbH | Photon geocoder (Pulse address autocomplete) | Every keystroke + user IP | DE (EU) | **TODO — confirm DPA exists** | Adequacy (intra-EU) | — | **High — current implementation leaks keystrokes without consent (S-M13). Block until proxied + consent banner added.** |
| Google LLC | Google Geocoding API — cire per-event venue lookup on the organiser Events tab (`cire/api`, server-side; platform Phase 0 PR 1) | The **organiser-provided event venue address only** (from their own events sheet) — one request per explicit "Look up" click, sent from the Worker (proxied — no browser-to-Google flow, no guest/organiser IP forwarded). Never guest data. | US | **TODO — sign Google Cloud DPA before setting `GOOGLE_GEOCODING_API_KEY` in prod** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm at key setup** | 2026-07-10 | Low — **key-optional + fail-soft**: no key ⇒ the endpoint answers `unavailable`, the location editor degrades to manual lat/lng entry, and nothing is sent to Google. Shipped inert until the key secret is set. Organiser-volunteered venue text only. |
| Grafana Labs | Grafana Cloud (logs / traces / metrics) | Trace attrs incl. profile_id; redacted logs; metric samples | US | **TODO — sign Grafana Labs DPA + SCCs** | EU SCCs | — | Medium — observability data with profile_id and ip_hash. |
| Redis provider (TBD — Upstash / Redis Cloud) | Rate-limit counters; rotated-session detection; auth state (Phase 4) | Hashed session tokens; IP-derived counters | TBD | **TODO — sign on choice** | EU SCCs if US-hosted | — | High — auth state. Pick EU region by default. |
| Upstash, Inc. | Upstash Redis (REST/HTTP) — edge-compatible Redis backend for `@osn/api` on Cloudflare Workers (the P2 backend in `@shared/redis`). Holds rotated-session family ids, ceremony/step-up `jti` state, recovery-lockout counters, and rate-limit keys (which incorporate HMAC-peppered IP hashes + account-derived keys). All **pseudonymised** — hashes, opaque ids, short-lived ceremony state; **no raw PII**. | Pseudonymised auth/rate-limit state: hashed session-family ids, step-up/ceremony jti, recovery-lockout counters, HMAC-peppered IP-hash + account-derived rate-limit keys | **`ap-southeast-2` (Sydney, Australia).** Chosen for AU data locality + latency — co-located with the D1 databases (`oc`/Sydney) and the Australian edge traffic, minimising RSVP/auth-write round-trips. | **TODO — sign at Phase-6 wiring (C-H5)** | AU-hosted, so EU/UK guest data would transit to AU — covered by the same consent/notice basis as the rest of the guest data (see [[gdpr]] "International transfers" + [[retention]]); not a new transfer concern for a pseudonymised cache. | — | High — auth/rate-limit state. **Introduced by the P2 backend; becomes active only when the Phase-6 Workers entry is wired + deployed — not on any live path yet.** Pseudonymised only. Region now locked (`ap-southeast-2`); DPA still to sign under C-H5. |
| Supabase Inc. (planned migration target) | Production Postgres | Everything | EU region selectable | **TODO — sign at migration time** | Adequacy if EU region | — | Critical — primary data store. |
| Stripe (planned, Pulse ticketing) | Hosted checkout | Payment data (never touches OSN DB); customer email + name | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope. |
| Stripe (**cire gift registry** — Connect, open PR #1001) | Connect so a wedding guest can send the couple a cash gift. **No integration code has shipped.** The two pull requests this row used to name — #760 for onboarding and #762 for Checkout — were both closed without merging. The whole flow now sits on a single open pull request, #1001, and nothing on `main` calls Stripe. What did reach `main` is schema and nothing else: the `stripe_*` columns on `registry_settings` and `registry_contributions`, folded into `0001_initial.sql` by the 2026-09-10 migration squash. The code on #1001 is inert as well — `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are unset on every tier, so no route is mounted and no byte flows to Stripe. What that code does once a key is set: creates the couple's connected account (`POST /v1/accounts`, `card_payments` + `transfers` requested), mints onboarding links, reads the account once when the couple return from onboarding, and keeps `charges_enabled`, `payouts_enabled` and the account's `default_currency` in step from the `account.updated` webhook onto `registry_settings` (see [[data-map]], [[cire-registry]]). The account type is **Express** as the branch stands, and is an open decision: it cannot be changed after the first account exists, so read the type off the code before trusting this cell. Hosted Checkout — **direct charges on the couple's own connected account** — is on the same pull request: cire is the platform, never the merchant of record, and gift funds never enter a cire balance, which is what keeps the platform out of money transmission. cire stores only the Checkout Session / PaymentIntent references, the settled amounts and any amount refunded (`registry_contributions` row in [[data-map]]). | What cire **sends** Stripe: the wedding id (account metadata), the account country (deployment default `AU`), the portal return/refresh URLs, and Checkout Session parameters (amount, currency, wedding/household references). What cire **receives + stores**: the connected account id, the two capability booleans, the account's settlement currency (`default_currency`), Stripe's event timestamp, and — per contribution — the Checkout Session and PaymentIntent ids, the settled amount and the amount refunded so far. What Stripe collects **directly, never through cire**: the couple's KYC identity + bank details (Stripe-hosted onboarding) and the guest's card data + name/email (hosted Checkout) — card data never touches cire's D1. | US/IE (platform contract expected with Stripe's Australian entity for an AU platform — confirm at acceptance) | **TODO — NOTHING ACCEPTED OR SIGNED (as of 2026-09-14).** The Stripe DPA is not a wet-ink document: it is incorporated into the Stripe Services Agreement, accepted in the Dashboard at account activation; the Connect platform terms are accepted in the Dashboard when Connect is enabled. Work the checklist in §"Stripe Connect (cire) — the paperwork gate" below. **When done, replace this cell with the acceptance dates** (SSA/DPA and Connect terms) — this cell is where the execution record lives. | **TODO — confirm at acceptance**: Stripe's DPA incorporates SCCs for EEA/UK data; check Stripe's DPF status on the version in force. The platform entity is Australian, so APP 8 (cross-border disclosure) applies to AU guest/couple data too. | 2026-09-14 | Medium-high — financial, and the first cire flow with a payment processor. PCI-DSS SAQ-A scope (redirect to hosted Checkout, no card fields on our origin). Controller/processor split matters here — see the note under the checklist. **Erasure gap C-H13** (see [[retention]]): deleting a wedding removes cire's columns but no code deletes the connected account, and Stripe retains the couple's KYC under its own AML obligations as an independent controller. |
| Stripe (**cire self-serve upgrades** — PLATFORM checkout) | A cire host buys a locked module (`vendors`, `registry`). **cire is the merchant of record here** — the opposite of the gift-registry row above, where the couple are and the charge is direct on their connected account. Card details never touch cire: the payment happens on Stripe's hosted Checkout page. What cire stores is the Checkout Session id, the payment-intent id, the amount and the purchasing owner's OSN profile id (`wedding_upgrade_purchases`), plus an aggregate sales row carrying no person (`platform_sales`). | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope (hosted checkout, no card data in scope). Separate webhook endpoint and signing secret from the Connect integration; see `wiki/systems/cire-upgrades.md`. |

### Stripe Connect (cire) — the paperwork gate

Two independent security reviews gated the first attempt at this work
(PR #760) on this row. State on 2026-09-14: **nothing has shipped, and
every agreement below is outstanding.** Nobody has accepted or signed
anything. A reader should take this section at face value: the human
steps are not done until the dates are in the row above.

**Who is who.** Three relationships, three papers — do not conflate them:

| Relationship | Paper | Roles |
|---|---|---|
| cire platform ↔ Stripe | Stripe Services Agreement (SSA), which **incorporates the Stripe DPA** — accepted in the Dashboard at account activation, not signed on paper | cire is controller of the platform data it sends (wedding id, country, return URLs, Checkout parameters). Stripe is **processor under the DPA** for data it handles on cire's instruction, and an **independent controller** for payment processing, fraud and regulatory compliance — the DPA itself draws this line; read it on the version accepted. |
| cire platform ↔ Stripe, Connect specifically | Connect platform terms, accepted in the Dashboard when Connect is enabled (plus Stripe's platform review/questionnaire). For Express, the platform bears negative-balance loss liability — accept knowingly. | Governs cire's responsibilities for the accounts it onboards. |
| couple ↔ Stripe | Stripe Connected Account Agreement, accepted by the couple during Express onboarding | The couple are the merchant of record for their own gifts. Stripe collects their KYC identity + bank details **directly, as its own controller** (AML/KYC obligations) — cire never sees that data and no cire↔Stripe paper covers it. The couple's Stripe account is their own merchant relationship. |

So: the **DPA** covers the narrow platform-data flow cire actually has;
the **Connect terms** cover the platform role; the couple's KYC needs no
paper from cire because cire is not in that flow at all.

**The checklist, and what it gates.** The reviews wrote steps 1–4 as a
pre-merge gate, when the plan was that merging the code and keying it
were the same act. They are not the same act: without
`STRIPE_SECRET_KEY` the routes are never mounted, so merging discloses
nothing to Stripe and creates no account. So every step below gates
**setting a key on a deployed tier**, not the merge — and steps 1–2 gate
it whether the key is a test key or a live one, because a sandbox
account is still an account with the operating entity's name on it. The
register does not lie in the meantime: the row above says the code has
not shipped and no agreement exists, which is the truth on both sides of
the merge.

1. **Create + activate the Stripe account** for the operating entity — a
   director (or someone with authority to bind the company) does this in
   the Stripe Dashboard; activation is where the SSA, and with it the
   DPA, is accepted. Verify the DPA incorporation on the terms in force
   that day, and archive PDF copies of both.
2. **Enable Connect and accept the Connect platform terms** — same
   person, same Dashboard. Complete Stripe's platform profile; read the
   Express loss-liability position before accepting.
3. **Record the evidence.** Acceptance dates + versions + who accepted
   go in the gitignored business pages (entity details never commit —
   see the repo rule); the acceptance **dates** go in the "DPA on file?"
   cell of the row above, replacing the TODO.
4. **Confirm the transfer basis** on the accepted DPA (SCCs / DPF for
   EEA-UK data; APP 8 posture for the AU entity) and update the SCC
   cell; file `wiki/compliance/dtia/stripe.md` if the analysis warrants
   one. File the C-H13 erasure gap in `xchromo/osn-tracker`.
5. **Update the published notices before Checkout is live**: the guest
   site `/privacy` must name Stripe as a recipient for gift payments,
   and the organiser-facing copy must say Stripe collects the couple's
   KYC directly (also #1001's surface).
6. **Create the webhook endpoint** in the Dashboard →
   `https://api.cireweddings.com/api/stripe/webhook`, event
   `account.updated` plus the Checkout and refund events #1001 handles; capture the
   signing secret.
7. **Set the secrets** per [[access-control]] §Worker secrets —
   `wrangler secret put` on `cire-api-production`, then redeploy. Dev
   tier only ever holds test-mode keys (`sk_test_…`), never the live
   pair.
8. **Complete the PCI SAQ-A self-assessment** (Stripe Dashboard
   compliance flow) once Checkout is live.

### Link-outs (not processors)

User-initiated outbound links that send no OSN-held personal data on our behalf — no DPA required; listed here to answer the audit question in advance:

- **Google Maps** — Pulse venue page "Open in Maps" builds a `google.com/maps/search` URL from the venue address; nothing loads until the user deliberately clicks, so no ePrivacy consent trigger. See [[venues]].

## Sub-subprocessors

Sub-processors of our processors (e.g. Cloudflare's hosting providers,
Grafana's underlying cloud). The DPAs require us to list them; we mirror
the vendor's published list and re-check it quarterly.

- Cloudflare: see https://www.cloudflare.com/cloudflare-customer-subprocessors/
- Grafana Labs: see https://grafana.com/legal/subprocessors/
- Pinterest: see https://policy.pinterest.com/ (sub-processor list to confirm at DPA signing).
- Stripe: see https://stripe.com/legal/service-providers (confirm at SSA/DPA acceptance).
- (Add others as DPAs are signed.)

## Vendors we evaluated and rejected

| Vendor | Rejected because | Date |
|---|---|---|
| Sentry | Use Grafana Faro instead — same OTLP endpoint, fewer DPA surfaces | 2026-04 |
| (placeholder) | | |

## Per-vendor diligence checklist

Work through this list before you merge the PR that adds a new processor:

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

Do this when you remove a processor:

- [ ] Confirm data deletion certificate (or contractual deletion within DPA's offboarding window)
- [ ] Update [[data-map]] to remove the recipient
- [ ] Move the row from "Active" to "Removed" below
- [ ] Notify users only if material change to privacy notice (e.g. region change)

## Removed processors

(Empty — record here when offboarding happens.)
