---
title: Compliance Scope Matrix
tags: [compliance, scope, governance]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[soc2]]"
  - "[[ccpa]]"
  - "[[dsa]]"
  - "[[coppa]]"
  - "[[eaa]]"
last-reviewed: 2026-04-26
---

# Compliance Scope Matrix

Which standards apply to which user / surface, and why. Use this to scope a
new feature: trace your feature through the rows and you have its
compliance obligations.

## Scope by user location

| Where the user is | Primary regimes | Notes |
|---|---|---|
| EU + EEA + UK | GDPR, UK GDPR, ePrivacy, DSA, EAA | The strictest superset — design for this and everything else falls out. |
| California (US) | CCPA / CPRA | DSAR + opt-out + SPI limit + non-discrimination. |
| Other US states (VA, CT, TX, CO, UT, OR, IA, DE, FL, TN, IN, MT, NH, NJ, MN, RI…) | State privacy laws | All GDPR-shaped; deltas tracked in [[ccpa]]. |
| Anywhere with users <13 (US) | COPPA | We hard-gate at signup. |
| Brazil | LGPD | Defer to a future `wiki/compliance/non-eu-privacy-laws.md` page when traffic justifies. |
| Canada | PIPEDA | Defer. |
| Australia | Privacy Act 1988 | Defer. |
| Switzerland | nFADP | Defer; mostly aligns with GDPR. |
| Anywhere | Generic baseline (industry good practice) | SOC 2 controls cover this. |

## Scope by surface

| Surface | Personal data introduced | Compliance hooks |
|---|---|---|
| `@osn/api` registration | email, handle, IP (rate-limit), UA, passkey credential metadata | GDPR Art. 6(1)(b) lawful basis (contract); COPPA age gate at signup; CCPA notice at collection |
| `@osn/api` sessions | `ua_label`, `ip_hash` (HMAC-peppered), `last_used_at` | GDPR storage minimisation; SOC 2 CC6 logical access controls |
| `@osn/api` security events | `ip_hash`, UA, kind, timestamp | SOC 2 CC7 monitoring; GDPR Art. 32 |
| `@pulse/api` events | event title, description, location (lat/lng), guest list, RSVPs | GDPR (special-category if event reveals health / orientation / political views); DSA (UGC); EAA (UI WCAG) |
| `@pulse/api` discovery (Photon geocoder) | every keystroke sent to a third party | **Outstanding gap** — S-M13 in security backlog. Needs proxy + IP shielding OR explicit consent. Until fixed, we are out of compliance with GDPR data-minimisation. |
| `@zap/api` DMs | message ciphertext (E2E), sender / recipient handles, timestamps | GDPR (metadata is personal data even when content is encrypted); ePrivacy Art. 5(1); CDA / DSA notice-and-action for reports |
| `@zap/api` org chats (M3) | customer chat transcripts under verified org | **B2B trigger for SOC 2 Type II.** Customer becomes a controller, OSN becomes processor → DPA required. |
| `@zap/api` locality channels (M4) | locality opt-in (= location), broadcast subscriptions | GDPR Art. 9 if locality reveals special-category info; DSA broadcaster transparency |
| Pulse ticketing (deferred) | payment data | PCI-DSS SAQ-A via Stripe-hosted; never touches our DB |
| AI surfaces (Zap M5, Pulse discovery v2, locality query M4) | prompt + response + (potentially) chat history | EU AI Act transparency obligations; GDPR Art. 22 (no solely-automated decisions with legal effect); model-provider DPA |
| Landing | analytics cookie / pixel (if added) | ePrivacy consent banner. Today there are no analytics → compliant. Stay this way OR add a Klaro/Cookiebot-style banner. |

## "Minimum viable compliance" surface per standard

What ships in the **first** compliance push. Subsequent rounds harden.

### GDPR — first cut

1. Privacy notice page on `@osn/landing` linking from every registration form.
2. `[[data-map]]` published as the Article 30 record of processing.
3. `[[subprocessors]]` published with current DPAs on file.
4. DSAR endpoints: `GET /account/export` (machine-readable JSON) and `DELETE /account` (full erasure with cross-service fan-out via ARC).
5. Retention schedule enforced ([[retention]]) — Grafana Cloud retention already tight (14 d traces, 50 GB logs, 30 d metrics on free tier); production sessions auto-expire; security events retained 12 months; deleted-account tombstone retained 30 days.
6. Lawful basis declared per processing purpose in `[[data-map]]`.
7. Breach response runbook ([[breach-response]]) with named DPO contact.
8. Cookie banner on `@osn/landing` only if/when analytics added.

### SOC 2 — first cut (Type I readiness)

Controls inventoried and evidenced; no auditor engagement yet. The audit
target is **CC1–CC9 + Confidentiality (C1) + Availability (A1) + Privacy
(P1–P8)**. Security is mandatory; we add Confidentiality, Availability, and
Privacy because they are the criteria customers ask about.

| TSC | What we evidence today | What is missing |
|---|---|---|
| CC1 — Control Environment | GitHub branch protection, codeowners, lefthook pre-commit/pre-push, oxlint, oxfmt, type check, mandatory PR review | Formal security policy doc; HR onboarding/offboarding checklist |
| CC2 — Communication | This wiki, CLAUDE.md, README.md, weekly review cadence | Public security.txt, vuln-disclosure policy |
| CC3 — Risk Assessment | Per-PR `/review-security` + `/review-performance` skills | Annual risk-assessment doc |
| CC4 — Monitoring | Grafana Cloud dashboards, OTel everywhere, security_events table | Alert routing doc, on-call rotation |
| CC5 — Control Activities | This page, the Security/Performance/Compliance backlogs in TODO.md | Quarterly access review record |
| CC6 — Logical Access | Passkey-primary login, step-up tokens, ARC tokens for S2S, role-gated org admin (M3) | Prod access control matrix ([[access-control]]); least-privilege review record |
| CC7 — System Operations | OTel, structured logs, Effect tracing, Redis health checks, /health + /ready endpoints | Capacity planning doc, vulnerability scan cadence |
| CC8 — Change Management | Changesets per PR, branch-protected main, CI required checks | Documented release procedure, rollback runbook |
| CC9 — Risk Mitigation | Rate limiting, CORS, Origin guard, redaction deny-list, CSP | Vendor risk-assessment record per [[subprocessors]] |
| C1 — Confidentiality | E2E (Signal/PQXDH), HMAC-peppered IPs, hashed tokens, redacted logs | Encryption-at-rest doc once Supabase migration lands |
| A1 — Availability | Bun runtime, Turbo build, OTel SLOs (planned), Redis fallback, fail-closed rate limiter | Backup + DR plan ([[backup-dr]]); RTO/RPO declared |
| P1–P8 — Privacy | This compliance directory, [[data-map]], [[dsar]] (planned) | Privacy notice published; consent records persisted |

### CCPA — first cut

The CCPA surface piggybacks on GDPR DSAR. Deltas:

- "Do Not Sell or Share My Personal Information" link on the landing page (we do not sell, but the link is mandatory if processing covered residents).
- "Limit the Use of My Sensitive Personal Information" if we ever process SPI for inference.
- Verifiable consumer requests: 45-day response window (vs GDPR 30).
- Authorised-agent flow.
- Children-under-16 opt-in (not opt-out) for sale / share — covered by COPPA gate.

### DSA — first cut

DSA applies to "hosting services" (we host UGC) and "online platforms"
(we connect users). Tier-2 obligations attach at >50 employees / €10M
turnover; we are below those thresholds today, so the **micro / SME
exemption** lifts most transparency-reporting and risk-assessment burdens.
Even in the exempt tier the following remain mandatory:

- Single point of contact (Art. 11 — provider) and electronic point of contact (Art. 12 — recipients of the service).
- Terms of Service that are clear, in plain language, listing content moderation rules, recourse, algorithmic ranking criteria.
- Notice-and-action mechanism (Art. 16) — anyone can flag illegal content with the prescribed minimum information.
- Statement of reasons (Art. 17) for every restriction (post removal, account suspension, demotion).
- Trader traceability (Art. 30) — when a trader (verified org under Zap M3) deals with consumers via the platform, we collect + verify their identity.
- Internal complaint-handling (Art. 20) — appeal against moderation decisions.
- Crisis response, recommender transparency, etc. — only Tier-3 (>45M EU users / VLOP). Far out.

### COPPA — first cut

We do not knowingly collect data from children under 13. The first cut is
a **hard age gate at registration** (`under_13 → 400`) and a written
take-down procedure if a violating account is reported. This is the
"actual knowledge" defense. Adding parental-consent flows is deferred
indefinitely — the platform is not designed for under-13 users.

### EAA — first cut

WCAG 2.1 AA across `@pulse/app`, `@osn/social`, `@zap/app` (when shipped),
and `@osn/landing`. Audited via:

- `@axe-core/playwright` in CI on the four apps.
- Solid-aware accessibility lint rule in `oxlintrc.json` (`jsx-a11y` already enabled).
- Manual screen-reader pass before each public release.
- Captioning / transcripts for any video content (Pulse promo / landing).

## Mapping standards → systems

| System page | GDPR | SOC 2 | CCPA | DSA | COPPA | EAA |
|---|---|---|---|---|---|---|
| [[identity-model]] | ✓ | CC6 | ✓ | — | gate | — |
| [[passkey-primary]] | Art. 32 | CC6 | — | — | — | — |
| [[sessions]] | Art. 5(1)(c), Art. 32 | CC6, CC7 | — | — | — | — |
| [[step-up]] | Art. 32 | CC6 | — | — | — | — |
| [[recovery-codes]] | Art. 32 | CC6 | — | — | — | — |
| [[arc-tokens]] | Art. 32 | CC6 | — | — | — | — |
| [[rate-limiting]] | Art. 32 | CC7 | — | — | — | — |
| [[email]] | Art. 28, Art. 44 (Cloudflare US transfer) | CC9 | ✓ | — | — | — |
| [[event-access]] | Art. 5(1)(f) | CC6 | — | DSA Art. 16 (event reports) | — | — |
| [[social-graph]] | Art. 5(1)(c) | — | ✓ | — | — | — |
| [[observability/overview]] | Art. 5(1)(c), Art. 32 | CC4, CC7 | — | — | — | — |
