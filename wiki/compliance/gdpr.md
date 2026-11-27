---
title: GDPR + UK GDPR
tags: [compliance, gdpr, privacy]
related:
  - "[[index]]"
  - "[[scope-matrix]]"
  - "[[data-map]]"
  - "[[dsar]]"
  - "[[retention]]"
  - "[[breach-response]]"
  - "[[subprocessors]]"
  - "[[identity-model]]"
  - "[[dpia/cire-guest-data]]"
last-reviewed: 2026-11-27
---

# GDPR + UK GDPR

OSN processes personal data of EU + UK end users (handles, emails, IP-derived
metadata, social-graph edges, RSVPs, message metadata). That puts us
in scope as a **controller** for first-party data and as a
**processor** for Zap M3 organisation-chat transcripts (the verified org
becomes the controller; we process on its instruction).

## Article-by-article obligations and where we stand

| Article | Obligation | OSN status | Page that implements it |
|---|---|---|---|
| Art. 5(1)(a) — Lawfulness, fairness, transparency | Tell users what we collect and why, before collecting | **Partial** — cire guest site ships `/privacy` + `/terms` with a site-wide footer; OSN landing-side notice still not built | [[data-map]] is the source; cire notice published, landing-side notice pending |
| Art. 5(1)(b) — Purpose limitation | Use data only for the declared purpose | OK in code; not documented | [[data-map]] |
| Art. 5(1)(c) — Data minimisation | Collect only what is needed | OK — no email duplication, accountId never leaves auth boundary, IPs are HMAC-peppered hashes, metric attrs bounded; cire's guest invite and gift pages send `X-Robots-Tag: noindex, nofollow`, so a couple's names and photo stay out of search indexes | [[identity-model]], [[sessions]], [[shared/observability/overview]], [[cire-invite-builder]] |
| Art. 5(1)(d) — Accuracy | Let users correct their data | Profile rename + handle update in `@musubi/social`; email change ceremony in `@osn/api`. **Gap** — no rectification API for non-self-service fields | [[identity-model]] |
| Art. 5(1)(e) — Storage limitation | Don't keep data forever | **Partial** — the schedule is [[retention]], and osn-api's sweeps for security events, email changes and handle holds run; Pulse event archival, Zap message expiry and the DSAR request log are not built | [[retention]] |
| Art. 5(1)(f) — Integrity + confidentiality | Encryption, access control, hashing, redaction | Strong: passkey-primary, ES256 access tokens, SHA-256 hashed sessions / OTP / recovery codes / CDL secrets, Argon2 not in scope (no passwords), TLS at edge, log redaction deny-list, CSP, CORS, Origin guard | Most `wiki/systems/` pages |
| Art. 6 — Lawful basis | Document the basis for each purpose | **Gap** — not documented per purpose | [[data-map]] |
| Art. 7 — Conditions for consent | Where consent is the basis (cookies, marketing, geocoder), record it and let users withdraw | **Gap** — Photon geocoder sends keystrokes without consent | Fix the geocoder leak; add consent-record table when first consent surface ships |
| Art. 9 — Special-category data | Extra protections for health / orientation / political views / etc. | **Indirect risk** — Pulse events can reveal these (Pride parade, AA meeting). Treat all event metadata as special-category in privacy notice. | [[event-access]] |
| Art. 12–15 — Right of access | Let users see what we hold | **Shipped** — `GET /account/export`, step-up gated, one a day, NDJSON with the `pulse.*`, `zap.*` and `cire.*` sections fetched over ARC | [[dsar]] |
| Art. 16 — Right of rectification | Edit incorrect data | Partial — see Art. 5(1)(d) | [[identity-model]] |
| Art. 17 — Right of erasure ("right to be forgotten") | Delete user + cascade across services | **Shipped** — `DELETE /account` from Musubi's Settings: a 7-day window the person can cancel, then a fan-out to Pulse, Zap and cire and the hard delete; `security_events` (12 months) and `email_changes` (90 days) kept under Art. 6(1)(c)+(f). Leaving one app: Pulse's leave route, cire's "Remove my Cire data" | [[dsar]], [[account-deletion]] |
| Art. 18 — Right to restriction | Suspend processing pending dispute | **Gap** — no "freeze account" admin tool | Future |
| Art. 20 — Right to data portability | Machine-readable export | **Shipped** — the Art. 15 export; direct transmission to another controller is not offered | [[dsar]] |
| Art. 21 — Right to object | Stop processing for direct marketing / legitimate-interest purposes | Today: no marketing email, no LI-based processing. Stay this way OR add an objection record. | — |
| Art. 22 — Automated decision-making | No solely-automated decisions with legal / similarly significant effect | Recs / discovery rank but don't gatekeep access to a service. **Risk** — DSA-driven content demotion is a "restriction" with significant effect; needs human-review path. | [[dsa]] |
| Art. 24 — Controller responsibility | Implement appropriate measures | Wiki + skills | This page |
| Art. 25 — Privacy by design + by default | Bake in at design time | Strong — multi-account audit (P6) was a privacy-by-design exercise | [[identity-model]] |
| Art. 28 — Processor obligations | Written contract with each processor | **Gap** — no DPA on file with Grafana Labs or Komoot (Photon). Cloudflare, Email Service included, is covered: its Customer DPA v6.4 applies through the Self-Serve Subscription Agreement §6.1. Resend, the live transactional-email processor, is covered: its DPA is incorporated into its Terms of Service and binds on acceptance (§12) | [[subprocessors]] |
| Art. 30 — Records of processing activities | Maintain a register | **Gap** — [[data-map]] is the seed; needs flesh + maintenance discipline | [[data-map]] |
| Art. 32 — Security of processing | Technical + organisational measures | Strong codified in skills | `.claude/skills/review-security/SKILL.md` |
| Art. 33 — Notification of breach to DPA | 72 hours | **Gap** — no runbook | [[breach-response]] |
| Art. 34 — Communication to data subject | Without undue delay if high risk | **Gap** — no template / channel | [[breach-response]] |
| Art. 35 — DPIA | For high-risk processing | **Required** for Pulse special-category event surfacing, Zap M3 customer-support transcripts, Zap M4 locality / government channels, AI surfaces, and **cire guest dietary special-category data (filed: [[dpia/cire-guest-data]]; gating consent mitigation resolved in PR #123, sign-off now pending only the residual retention items)** | One DPIA per feature, filed under `wiki/compliance/dpia/` |
| Art. 37 — DPO | Mandatory if core activities involve large-scale monitoring or special-category | **Probably** required once we cross EU user threshold + Pulse event special-category exposure. Designate before public launch. | This page |
| Art. 44–49 — International transfers | SCCs / adequacy / DTIA for non-EU recipients | **Gap** — Grafana Cloud (US) and planned Supabase (US/EU choice) need SCCs or another transfer basis, and a DTIA. Cloudflare's and Resend's SCCs come with their DPAs | [[subprocessors]] |

## Project changes required

Tracked with `C-` IDs in `englishstreetventures/osn-tracker` under `area:compliance`. The
high-impact ones, in priority order:

1. **Account-level data export endpoint** — built: `GET /account/export` ([[dsar#Art. 15 — Right of access]]).

2. **Account-level erasure endpoint** — built: `DELETE /account`, which reaches every app in `DELETION_APPS` (Pulse, Zap, cire) over ARC once the 7-day window closes ([[account-deletion]], [[dsar#Art. 17 — Right of erasure]]).

3. **Photon geocoder keystroke leak** — proxy through `@pulse/api` so Photon never sees the user IP, debounce server-side, and add a one-time consent dialog on first use ("Location lookups are sent to Photon, an open-source geocoder, to convert what you type into coordinates").

4. **Privacy notice + ToS** — public, plain-language, version-stamped, backlinked from every collection point. **RESOLVED for cire:** the guest site publishes `/privacy` + `/terms` with a site-wide footer — Australia/APP framing, the controller and DSAR contact both taken from `@shared/legal` rather than written into the page, 1-year retention basis, processors (Cloudflare), guest rights, and dietary/access free-text flagged as Art. 9 special-category collected under explicit consent. The parallel `@musubi/landing` notice now ships too, and so do Pulse's and the two app frontends' — sixteen pages: the privacy notice and terms of `cire/invites`, `musubi/landing` and `pulse/landing`, six on `cire/landing` (the privacy overview, the three notices, the terms and the refund policy), and those under `musubi/social/src/pages/` and `pulse/web/src/routes/`. There is no drafts directory: the operator's identity comes from `@shared/legal`, and every page gates a draft banner on `draftPending()` so it cannot publish an unfilled detail silently. Every field is filled, so no page shows the banner. The pages publish no postal address, by the owner's decision: the operator's name and its two mailboxes are its contact details.

5. **DPA + SCC pack for processors** — Cloudflare's Customer DPA (v6.4, with the EU SCCs and UK Addendum) is incorporated into its Self-Serve Subscription Agreement and recorded per row in [[subprocessors]]. Resend's DPA (with the EU SCCs, UK Addendum, Swiss modifications and its Data Privacy Framework certification) binds on acceptance of its Terms and is recorded in [[subprocessors]]. Still to do: the Grafana Labs DPA + SCCs, and Photon's DPA-equivalent (Komoot). File under `wiki/compliance/dpa/<vendor>.md` with execution date + scope.

6. **DSAR runbook** — an operational doc that covers ID verification, the 30-day clock, the unverified-request response, the "manifestly unfounded" denial path, and where to log requests for audit. See [[dsar]].

7. **Retention enforcement** — schedule documented + tested deletes for: dev OTP/magic store sweep, security_events older than 12 months, sessions older than 30 days (already auto-expire), Grafana logs (already 50 GB rolling), Pulse RSVPs of cancelled events. Built for osn-api: `security_events` past 12 months, `email_changes` past 90 days and released handle holds, on its 6-hourly cron. See [[retention]].

8. **DPIA template + filings** — one for Pulse event special-category exposure, one for Zap M3 org-chat transcripts (before M3 ships), one for Zap M4 locality channels (before M4 ships), and the **cire guest-data DPIA** ([[dpia/cire-guest-data]]) **filed with the cire merge — the gating dietary-consent affordance (the dietary consent gate) shipped PR #123; sign-off now turns only on the residual retention items**.

9. **Consent-record table** — `consents (id, account_id, purpose, given_at, withdrawn_at, evidence)` for OSN-side consent purposes. Required once we have a consent-based OSN purpose (geocoder, marketing email, analytics). cire's `rsvps.dietary` Art. 9(2)(a) explicit consent is **already captured** via dedicated columns on the `rsvps` row (`dietary_consent_at` / `dietary_consent_version`, PR #123) rather than this shared table.

10. **DPO designation + public contact** — even if not strictly required, naming a DPO simplifies enterprise-customer DPAs. Email alias + named human responsible.

## Daily habits this introduces

| Habit | Where it lives |
|---|---|
| Every PR that introduces a new personal-data field updates [[data-map]] | `/review-security` checklist |
| Every PR that adds a new third party updates [[subprocessors]] | `/review-security` checklist |
| Every PR that creates a new processing purpose declares its lawful basis | `/review-security` checklist |
| Every feature with high-risk processing files a DPIA before merge | `/review-security` checklist |
| Every retention-relevant column documents its TTL | [[retention]] |
