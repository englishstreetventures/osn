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
last-reviewed: 2026-10-26
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
| Resend (Plus Five Five, Inc.) | Resend HTTP API (transactional outbound — **live transport**, `api.resend.com/emails`) | Recipient email + message body (OTPs, security notices: passkey added/removed, recovery codes, cross-device login; **vendor claim-invite emails from cire-api with vendor sole-trader email address**; **cire's daily RSVP digest to a wedding's owner and editors — the organiser's address, the wedding's name and counts only, no guest data, plus a signed stop link carrying the wedding id and the organiser's OSN profile id (encoded, not encrypted)**; **cire's parting gift-record email to a wedding's owners, sent by the one-year guest-data sweep — the owner's address, the wedding's name, list counts, and each money gift's amount, currency and day: guest personal data, though no guest is named ([[data-map]])**) | US | **TODO — sign Resend DPA** | **TODO — EU→US transfer basis (DPF self-cert or SCCs) to confirm before the `RESEND_API_KEY` secret is set in any EU-data env** | 2026-07-17 | Medium — has email content. Now the live transactional-email processor (supersedes Cloudflare Email Service). Senders: osn-api (security notices), cire-api (claim invites, the RSVP digest, the gift-record email). The gift-record email is the first cire flow through Resend that carries guest data, and only once money gifts exist — see step 9 of the Stripe Connect gate below. |
| Cloudflare, Inc. | Cloudflare Email Service (transactional outbound — **legacy fallback**, superseded by Resend) | Recipient email + message body (OTPs, security notices) | US | **TODO — sign Cloudflare DPA** | EU SCCs (template in DPA) | — | Medium — has email content. Used only if `RESEND_API_KEY` is absent. |
| Cloudflare, Inc. | Cloudflare DNS / TLS edge (planned for production) | IP, request metadata | US | Same DPA | EU SCCs | — | Low — transient. |
| Cloudflare, Inc. | Cloudflare Workers Logs and native Workers traces — application logs from the deployed Workers; traces of every request to the production guest site (`cire-invites`) and to every dev-tier API Worker and the dev guest site | Request path (an existing `/<slug>` guest link names the couple), user agent, country and city derived from the visitor's IP, network (ASN), `Accept-Language`, outbound API URLs; query strings redacted in production and on every dev Worker but zap-api. No body, cookie or client IP. Fields and retention in [[data-map]] | US | Same DPA | EU SCCs | 2026-10-15 | Low — technical metadata, 3–7 days. |
| Cloudflare, Inc. | Cloudflare D1 + R2 (`cire-sheets`) — cire wedding-invite store | **Guest PII at volume**: family names, guest names, RSVP status, **special-category dietary free-text (Art. 9)**, guest claim codes; raw organiser CSV uploads in R2 | US (account region — confirm D1/R2 location) | Same Cloudflare DPA | EU SCCs | — | **High — first persistent special-category store (dietary) + a separate DB Cloudflare now hosts as data store, not just edge. Confirm D1/R2 data-residency under the DPA.** |
| Cloudflare, Inc. | Cloudflare Durable Objects — cire-api's realtime push hub (`REALTIME_HUB`, the `TopicHub` class from `@shared/realtime`), one object per wedding topic | The signed-in organiser's `osnProfileId` (an opaque OSN profile id, no handle or email; any seat, a helper's included) as a tag on each open WebSocket (`subject:<osnProfileId>`), the wedding id in the object's name (`cire:wedding:<weddingId>`), plus the socket's connection metadata. A signal carries no data, only that a wedding's seats or tasks changed | Dynamic: an object is placed near the first request that creates it. No jurisdiction is set on the binding, so the location is not fixed | **TODO** — the Cloudflare DPA in the first Cloudflare row, not yet signed | EU SCCs, once that DPA is signed | 2026-10-21 | Low — pseudonymous id and an entity id, held in memory for the socket's lifetime and dropped when it closes. Nothing is written to Durable Object storage. To fix the region, the hub would be reached through a namespace with a jurisdiction set. See [[realtime]]. |
| Pinterest, Inc. | `pinit_main.js` inspiration-board embed on the guest site (`@cire/invites`) | IP, user-agent, and on-page behaviour of guests who have switched on Pinterest moodboards | US | **TODO — no Pinterest DPA / SCCs on file** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — governed by its own consent switch, "Pinterest moodboards" (the `pinterest` category, `[[cire-consent]]`), which is **off until the guest allows it**: nothing of Pinterest's loads for a guest who has not decided. The first-visit prompt (a dialog on the invite's pages that only an answer closes, with "Accept all", "Reject all" and "Choose" as equal answers) names Pinterest and says its content stays off until allowed; "Choose" allows Pinterest without Google Maps. Withdrawable at any time from a standing footer control and, while the moodboard is on, from "Stop showing moodboards" under it in the event sheet; a refusal is honoured permanently. `<ConsentGate>` does not render the embed while consent is absent, so the tracker is never injected. A block with an outbound link to the board ("Open on Pinterest") shows whenever the embed is not showing — not yet allowed, refused, blocked or timed out — so declining costs the guest nothing. The gate, not the device, is the control. The tracker does not fire for an undecided guest: `CATEGORY_META.pinterest.defaultGranted` in `cire/ui/src/consent-categories.ts` is `false`, so the embed waits for prior consent. The DPA and transfer-basis cells above remain open. |
| Google LLC | Google Maps Embed API `place` iframe on the guest site (`@cire/invites` `MapPreview`) — venue map inside the event-details sheet | IP + user-agent of guests who have switched on Google Maps; the venue address, or the venue's name when the event has no address, is in the iframe URL. Referrer trimmed to origin so the slug-/`?code=`-bearing invite path is never sent. | US | **TODO — sign Google Cloud DPA** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — **brought under the consent framework 2026-07-29**; previously loaded for every guest with a venue address and offered no way to stop it. Now behind its own consent switch, "Google Maps" (the `maps` category) — **off until the guest allows it**, separately from Pinterest, disclosed on the first-visit prompt, listed in the privacy notice, and switchable off again; until then, and after a refusal, the self-contained CSS map card stands in (no network request). Also key-optional: with no `PUBLIC_GOOGLE_MAPS_EMBED_KEY` the iframe never renders. |
| Google LLC | Google Fonts (`fonts.googleapis.com` stylesheet + `fonts.gstatic.com` woff2) on the guest site (`@cire/invites`) | IP + user-agent of **every** guest | US | **TODO — sign Google Cloud DPA** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm** | 2026-07-29 | Medium — **the one third party the consent gate does NOT cover**: the font `<link>` is in the `<head>` of the server-rendered document, so it is requested before any choice can apply. Declared `enforcement: "always"` in the vendor registry and disclosed as "loads on every visit" in both the preferences dialog and `/privacy` rather than implied to be covered. **Remediation is removal, not gating** — self-host the two woff2 families and this row disappears; tracked as an open issue in `englishstreetventures/osn` (`label:product:cire`). |
| Komoot GmbH | Photon geocoder (Pulse address autocomplete) | Every keystroke + user IP | DE (EU) | **TODO — confirm DPA exists** | Adequacy (intra-EU) | — | **High — current implementation leaks keystrokes without consent. Block until proxied + consent banner added.** |
| Google LLC | Google Geocoding API — cire per-event venue lookup on the organiser Events tab (`cire/api`, server-side; platform Phase 0 PR 1) | The **organiser-provided event venue address only** (from their own events sheet) — one request per explicit "Look up" click, sent from the Worker (proxied — no browser-to-Google flow, no guest/organiser IP forwarded). Never guest data. | US | **TODO — sign Google Cloud DPA before setting `GOOGLE_GEOCODING_API_KEY` in prod** | **TODO — EU→US transfer basis (DPF or SCCs) to confirm at key setup** | 2026-07-10 | Low — **key-optional + fail-soft**: no key ⇒ the endpoint answers `unavailable`, the location editor degrades to manual lat/lng entry, and nothing is sent to Google. Shipped inert until the key secret is set. Organiser-volunteered venue text only. |
| Grafana Labs | Grafana Cloud (logs / traces / metrics) | Trace attrs incl. profile_id; redacted logs; metric samples | US | **TODO — sign Grafana Labs DPA + SCCs** | EU SCCs | — | Medium — observability data with profile_id and ip_hash. |
| Redis provider (TBD — Upstash / Redis Cloud) | Rate-limit counters; rotated-session detection; auth state (Phase 4) | Hashed session tokens; IP-derived counters | TBD | **TODO — sign on choice** | EU SCCs if US-hosted | — | High — auth state. Pick EU region by default. |
| Upstash, Inc. | Upstash Redis (REST/HTTP) — edge-compatible Redis backend for `@osn/api` on Cloudflare Workers (the P2 backend in `@shared/redis`). Holds rotated-session family ids, ceremony/step-up `jti` state, recovery-lockout counters, and rate-limit keys (which incorporate HMAC-peppered IP hashes + account-derived keys). All **pseudonymised** — hashes, opaque ids, short-lived ceremony state; **no raw PII**. | Pseudonymised auth/rate-limit state: hashed session-family ids, step-up/ceremony jti, recovery-lockout counters, HMAC-peppered IP-hash + account-derived rate-limit keys | **`ap-southeast-2` (Sydney, Australia).** Chosen for AU data locality + latency — co-located with the D1 databases (`oc`/Sydney) and the Australian edge traffic, minimising RSVP/auth-write round-trips. | **TODO — sign at Phase-6 wiring** | AU-hosted, so EU/UK guest data would transit to AU — covered by the same consent/notice basis as the rest of the guest data (see [[gdpr]] "International transfers" + [[retention]]); not a new transfer concern for a pseudonymised cache. | — | High — auth/rate-limit state. **Introduced by the P2 backend; becomes active only when the Phase-6 Workers entry is wired + deployed — not on any live path yet.** Pseudonymised only. Region now locked (`ap-southeast-2`); DPA still to sign. |
| Supabase Inc. (planned migration target) | Production Postgres | Everything | EU region selectable | **TODO — sign at migration time** | Adequacy if EU region | — | Critical — primary data store. |
| Stripe (planned, Pulse ticketing) | Hosted checkout | Payment data (never touches OSN DB); customer email + name | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope. |
| Stripe (**cire gift registry** — Connect) | Connect so a wedding guest can send the couple a cash gift. The integration is on `main` — `cire/api/src/services/stripe.ts`, the registry Stripe and contribute routes, and the Connect webhook ([[stripe-webhooks]]) — and is inert on a tier until `STRIPE_SECRET_KEY` (and, for the webhook, `STRIPE_WEBHOOK_SECRET`) is set there: with no key no route is mounted and no byte flows to Stripe, and a guest is sent to Checkout only where both are set. What it does once a key is set: creates the couple's connected account (`POST /v1/accounts`, `card_payments` + `transfers` requested), mints onboarding links, reads the account once when the couple return from onboarding, and keeps `charges_enabled`, `payouts_enabled` and the account's `default_currency` in step from the `account.updated` webhook onto `registry_settings` (see [[data-map]], [[cire-registry]]). The account type is **Express** as the branch stands, and is an open decision: it cannot be changed after the first account exists, so read the type off the code before trusting this cell. Hosted Checkout — **direct charges on the couple's own connected account** — is part of the same integration: cire is the platform, never the merchant of record, and gift funds never enter a cire balance, which is what keeps the platform out of money transmission. cire stores only the Checkout Session / PaymentIntent references, the settled amounts and any amount refunded (`registry_contributions` row in [[data-map]]). | What cire **sends** Stripe: the wedding id (account metadata), the account country (deployment default `AU`), the portal return/refresh URLs, and Checkout Session parameters: the amount and currency, the fixed product name "Wedding gift", success and cancel URLs carrying the wedding's slug, an expiry an hour ahead, and one opaque gift id (`rct_…`) as `client_reference_id` and as session and PaymentIntent metadata — no household, guest name or note. What cire **receives + stores**: the connected account id, the two capability booleans, the account's settlement currency (`default_currency`), Stripe's event timestamp, and — per contribution — the Checkout Session and PaymentIntent ids, the settled amount and the amount refunded so far. What Stripe collects **directly, never through cire**: the couple's KYC identity + bank details (Stripe-hosted onboarding) and the guest's card data + name/email (hosted Checkout) — card data never touches cire's D1. | US/IE (platform contract expected with Stripe's Australian entity for an AU platform — confirm at acceptance) | **TODO — NOTHING ACCEPTED OR SIGNED (as of 2026-09-14).** The Stripe DPA is not a wet-ink document: it is incorporated into the Stripe Services Agreement, accepted in the Dashboard at account activation; the Connect platform terms are accepted in the Dashboard when Connect is enabled. Work the checklist in §"Stripe Connect (cire) — the paperwork gate" below. **When done, replace this cell with the acceptance dates** (SSA/DPA and Connect terms) — this cell is where the execution record lives. | **TODO — confirm at acceptance**: Stripe's DPA incorporates SCCs for EEA/UK data; check Stripe's DPF status on the version in force. The platform entity is Australian, so APP 8 (cross-border disclosure) applies to AU guest/couple data too. | 2026-09-14 | Medium-high — financial, and the first cire flow with a payment processor. PCI-DSS SAQ-A scope (redirect to hosted Checkout, no card fields on our origin). Controller/processor split matters here — see the note under the checklist. **Erasure gap** (see [[retention]]): deleting a wedding removes cire's columns but no code deletes the connected account, and Stripe retains the couple's KYC under its own AML obligations as an independent controller. |
| Stripe (**cire self-serve upgrades** — PLATFORM checkout) | A cire host buys a locked module (`vendors`, `registry`). **cire is the merchant of record here** — the opposite of the gift-registry row above, where the couple are and the charge is direct on their connected account. Card details never touch cire: the payment happens on Stripe's hosted Checkout page. What cire stores is the Checkout Session id, the payment-intent id, the amount and the purchasing owner's OSN profile id (`wedding_upgrade_purchases`), plus an aggregate sales row carrying no person (`platform_sales`). | US/IE | **TODO — Stripe DPA** | EU SCCs | — | Medium — financial. PCI-DSS SAQ-A scope (hosted checkout, no card data in scope). Separate webhook endpoint and signing secret from the Connect integration; see `wiki/cire/cire-upgrades.md`. |

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
   one. File any gap the DPA review finds in the private tracker.
5. **Update the published notices before Checkout is live**: the guest
   site `/privacy` names Stripe as the recipient of gift payments and
   what it collects (done 2026-10-15); the organiser-facing copy must
   still say Stripe collects the couple's KYC directly.
6. **Create the webhook endpoint** in the Dashboard →
   `https://api.cireweddings.com/api/stripe/webhook`, subscribed to the
   nine events [[stripe-webhooks]] lists; capture the signing secret.
7. **Set the secrets** per [[access-control]] §Worker secrets —
   `wrangler secret put` on `cire-api-production`, then redeploy. Dev
   tier only ever holds test-mode keys (`sk_test_…`), never the live
   pair.
8. **Complete the PCI SAQ-A self-assessment** (Stripe Dashboard
   compliance flow) once Checkout is live.
9. **Sign the Resend DPA and confirm its transfer basis** (the Resend
   row above). Once money gifts exist, the one-year sweep's gift-record
   email carries each gift's amount, currency and day through Resend, so
   the Resend paperwork gates a Stripe key as much as Stripe's own does.

### Link-outs (not processors)

User-initiated outbound links that send no OSN-held personal data on our behalf — no DPA required; listed here to answer the audit question in advance:

- **Google Maps** — Pulse venue page "Open in Maps" builds a `google.com/maps/search` URL from the venue address; nothing loads until the user deliberately clicks, so no ePrivacy consent trigger. See [[venues]].
- **Google Maps, Apple Maps, Waze, and the organiser's own map link** — the cire guest site's "Open in maps" menu on an event's details. It offers a Google Maps search (`www.google.com/maps/search`), Apple Maps (`maps.apple.com`) and Waze (`waze.com`), and the organiser's own maps link when the event has one, which may point at any http(s) site. Each URL carries the venue's address, or its name when there is no address, in its query; a private home's address is personal data. Nothing loads until the guest clicks an entry, and every entry opens in a new tab with `rel="noopener noreferrer"`, so neither the invite's slug- and code-bearing path nor the invite window reaches the other site. No ePrivacy consent trigger. The Google Maps *embed* beside it is a processor (the row above), behind the `maps` consent switch. See [[cire-consent]] and [[cire-invite-designs]].

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
