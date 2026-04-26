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
last-reviewed: 2026-04-26
---

# GDPR + UK GDPR

OSN processes personal data of EU + UK end users (handles, emails, IP-derived
metadata, social-graph edges, RSVPs, message metadata). That puts us
squarely in scope as a **controller** for first-party data and as a
**processor** for Zap M3 organisation-chat transcripts (the verified org
becomes the controller; we process on its instruction).

## Article-by-article obligations and where we stand

| Article | Obligation | OSN status | Page that implements it |
|---|---|---|---|
| Art. 5(1)(a) — Lawfulness, fairness, transparency | Tell users what we collect and why, before collecting | **Gap** — no privacy notice published | [[data-map]] is the source; landing-side notice not built |
| Art. 5(1)(b) — Purpose limitation | Use data only for the declared purpose | OK in code; not documented | [[data-map]] |
| Art. 5(1)(c) — Data minimisation | Collect only what is needed | OK — no email duplication, accountId never leaves auth boundary, IPs are HMAC-peppered hashes, metric attrs bounded | [[identity-model]], [[sessions]], [[observability/overview]] |
| Art. 5(1)(d) — Accuracy | Let users correct their data | Profile rename + handle update in `@osn/social`; email change ceremony in `@osn/api`. **Gap** — no rectification API for non-self-service fields | [[identity-model]] |
| Art. 5(1)(e) — Storage limitation | Don't keep data forever | **Gap** — no documented retention schedule | [[retention]] |
| Art. 5(1)(f) — Integrity + confidentiality | Encryption, access control, hashing, redaction | Strong: passkey-primary, ES256 access tokens, SHA-256 hashed sessions / OTP / recovery codes / CDL secrets, Argon2 not in scope (no passwords), TLS at edge, log redaction deny-list, CSP, CORS, Origin guard | Most [[systems]] pages |
| Art. 6 — Lawful basis | Document the basis for each purpose | **Gap** — not documented per purpose | [[data-map]] |
| Art. 7 — Conditions for consent | Where consent is the basis (cookies, marketing, geocoder), record it and let users withdraw | **Gap** — Photon geocoder sends keystrokes without consent (S-M13) | Fix S-M13; add consent-record table when first consent surface ships |
| Art. 9 — Special-category data | Extra protections for health / orientation / political views / etc. | **Indirect risk** — Pulse events can reveal these (Pride parade, AA meeting). Treat all event metadata as special-category in privacy notice. | [[event-access]] |
| Art. 12–15 — Right of access | Let users see what we hold | **Gap** — no `GET /account/export` | [[dsar]] |
| Art. 16 — Right of rectification | Edit incorrect data | Partial — see Art. 5(1)(d) | [[identity-model]] |
| Art. 17 — Right of erasure ("right to be forgotten") | Delete user + cascade across services | **Gap** — `deleteProfile` exists; no `DELETE /account` that fans out to Pulse RSVPs, Zap chat membership, security events, sessions, security_events, recovery_codes, passkeys | [[dsar]] |
| Art. 18 — Right to restriction | Suspend processing pending dispute | **Gap** — no "freeze account" admin tool | Future |
| Art. 20 — Right to data portability | Machine-readable export | **Gap** — same endpoint as Art. 15 in JSON satisfies this | [[dsar]] |
| Art. 21 — Right to object | Stop processing for direct marketing / legitimate-interest purposes | Today: no marketing email, no LI-based processing. Stay this way OR add an objection record. | — |
| Art. 22 — Automated decision-making | No solely-automated decisions with legal / similarly significant effect | Recs / discovery rank but don't gatekeep access to a service. **Risk** — DSA-driven content demotion is a "restriction" with significant effect; needs human-review path. | [[dsa]] |
| Art. 24 — Controller responsibility | Implement appropriate measures | Wiki + skills | This page |
| Art. 25 — Privacy by design + by default | Bake in at design time | Strong — multi-account audit (P6) was a privacy-by-design exercise | [[identity-model]] |
| Art. 28 — Processor obligations | Written contract with each processor | **Gap** — no DPAs on file with Cloudflare Email, Photon, Grafana Cloud, Redis provider | [[subprocessors]] |
| Art. 30 — Records of processing activities | Maintain a register | **Gap** — [[data-map]] is the seed; needs flesh + maintenance discipline | [[data-map]] |
| Art. 32 — Security of processing | Technical + organisational measures | Strong codified in skills | `.claude/commands/review-security.md` |
| Art. 33 — Notification of breach to DPA | 72 hours | **Gap** — no runbook | [[breach-response]] |
| Art. 34 — Communication to data subject | Without undue delay if high risk | **Gap** — no template / channel | [[breach-response]] |
| Art. 35 — DPIA | For high-risk processing | **Required** for Pulse special-category event surfacing, Zap M3 customer-support transcripts, Zap M4 locality / government channels, AI surfaces | One DPIA per feature, filed under `wiki/compliance/dpia/` |
| Art. 37 — DPO | Mandatory if core activities involve large-scale monitoring or special-category | **Probably** required once we cross EU user threshold + Pulse event special-category exposure. Designate before public launch. | This page |
| Art. 44–49 — International transfers | SCCs / adequacy / DTIA for non-EU recipients | **Gap** — Cloudflare (US), Grafana Cloud (US), planned Supabase (US/EU choice) all need SCCs + DTIAs | [[subprocessors]] |

## Project changes required

Tracked with `C-` IDs in the [[TODO]] Compliance Backlog. The high-impact
ones, in priority order:

1. **Account-level data export endpoint** — `GET /account/export` (auth + step-up gated). JSON bundle including: account row, all profiles, social-graph edges, blocks, RSVPs (via Pulse ARC fan-out), chat membership (via Zap ARC fan-out), security events, sessions metadata, recovery-code usage history. Streaming JSON (multi-MB plausible). Rate-limited 1/day/account. ID: **C-H1**. Owner: Identity team.

2. **Account-level erasure endpoint** — `DELETE /account` (auth + step-up gated, second confirmation, 7-day soft-delete window, then hard delete). Cascades via ARC to Pulse + Zap. Replaces user-visible profile rows with a deletion tombstone (`deleted_account_<id>` placeholder so RSVP histories remain queryable for the host without naming the deleted user). ID: **C-H2**.

3. **Photon geocoder keystroke leak (S-M13)** — proxy through `@pulse/api` so Photon never sees the user IP, debounce server-side, and add a one-time consent dialog on first use ("Location lookups are sent to Photon, an open-source geocoder, to convert what you type into coordinates"). ID: **C-H3**.

4. **Privacy notice + ToS on `@osn/landing`** — public, plain-language, version-stamped (`/legal/privacy?v=2026-04`), backlinked from every signup form. Drafts kept under `wiki/compliance/legal-drafts/`; published copy lives in `osn/landing/src/pages/legal/`. ID: **C-H4**.

5. **DPA + SCC pack for processors** — sign the Cloudflare DPA template, the Grafana Labs DPA + SCCs, the chosen Redis provider's DPA, and Photon's DPA-equivalent (Komoot). File under `wiki/compliance/dpa/<vendor>.md` with execution date + scope. ID: **C-H5**.

6. **DSAR runbook** — operational doc covering ID verification, the 30-day clock, the unverified-request response, the "manifestly unfounded" denial path, and where to log requests for audit. ID: **C-M1**. See [[dsar]].

7. **Retention enforcement** — schedule documented + tested deletes for: dev OTP/magic store sweep (P-W4), security_events older than 12 months, sessions older than 30 days (already auto-expire), Grafana logs (already 50 GB rolling), Pulse RSVPs of cancelled events, deletion tombstones older than 30 days. Cron job in `osn/api` or sidecar. ID: **C-M2**. See [[retention]].

8. **DPIA template + first three filings** — one for Pulse event special-category exposure, one for Zap M3 org-chat transcripts (before M3 ships), one for Zap M4 locality channels (before M4 ships). ID: **C-M3**.

9. **Consent-record table** — `consents (id, account_id, purpose, given_at, withdrawn_at, evidence)`. Only required once we have a consent-based purpose (geocoder, marketing email, analytics). ID: **C-L1**.

10. **DPO designation + public contact** — even if not strictly required, naming a DPO simplifies enterprise-customer DPAs. Email alias + named human responsible. ID: **C-L2**.

## Daily habits this introduces

| Habit | Where it lives |
|---|---|
| Every PR that introduces a new personal-data field updates [[data-map]] | `/review-security` checklist |
| Every PR that adds a new third party updates [[subprocessors]] | `/review-security` checklist |
| Every PR that creates a new processing purpose declares its lawful basis | `/review-security` checklist |
| Every feature with high-risk processing files a DPIA before merge | `/review-security` checklist |
| Every retention-relevant column documents its TTL | [[retention]] |
