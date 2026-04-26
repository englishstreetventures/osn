---
title: Compliance — Map of Content
aliases: [compliance, regulatory, privacy, soc2, gdpr]
tags: [compliance, index, governance]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[soc2]]"
  - "[[ccpa]]"
  - "[[dsa]]"
  - "[[coppa]]"
  - "[[eaa]]"
  - "[[data-map]]"
  - "[[subprocessors]]"
last-reviewed: 2026-04-26
---

# Compliance

OSN is a user-owned social platform with EU presence, B2B organisation chats
(Zap M3 — verified businesses, embeddable customer-support widget),
government / locality channels (Zap M4), and future paid event ticketing
(Pulse, deferred). That product surface puts us in scope for **GDPR,
UK GDPR, CCPA/CPRA, SOC 2, the EU Digital Services Act, COPPA, and the
European Accessibility Act** today, with PCI-DSS and the EU AI Act on the
horizon as those features land.

This Map of Content links each obligation to the system page that
implements it and the TODO row that tracks the remaining work. Read
`[[scope-matrix]]` first if you only have time for one page — it tells you
which laws apply, why, and what the per-standard "minimum viable
compliance" surface looks like.

## Standards we are in scope for

| Standard | Reason we are in scope | Status | Owner | Page |
|---|---|---|---|---|
| **GDPR / UK GDPR** | EU + UK end users on a social network. Lawful basis required for every processing purpose. | Plan only — DSAR + erasure routes not built | Identity team | [[gdpr]] |
| **CCPA / CPRA** | California end users. "Do Not Sell / Share" + "Limit Use of SPI" mandatory once revenue / record thresholds hit; build now to avoid retrofit. | Plan only | Identity team | [[ccpa]] |
| **SOC 2 (Trust Services Criteria — Security + Confidentiality + Availability + Privacy)** | Required by enterprise Zap-org customers before they will embed the support widget on their site. Type I before first paying org; Type II within 12 months. | Plan only — controls inventoried, no auditor engaged | Platform team | [[soc2]] |
| **EU Digital Services Act (DSA)** | Hosting service for user-generated content with EU recipients. Notice-and-action, transparency reporting, statement of reasons, trusted flaggers, ToS clarity. Independent of GDPR. | Plan only — moderation tooling not built | Pulse + Zap teams | [[dsa]] |
| **COPPA** | US under-13 users. Mandatory verifiable parental consent OR a hard age gate. We will gate at signup (no under-13 accounts). | Plan only — registration has no age check | Identity team | [[coppa]] |
| **EU ePrivacy Directive (cookie law)** | EU recipients. Strictly-necessary cookies are exempt; analytics / marketing require informed consent. Today we set only `osn_session` (HttpOnly, strictly necessary). | Compliant by absence — must stay this way | Platform team | [[eprivacy]] |
| **European Accessibility Act (EAA)** | Effective 28 June 2025. Consumer-facing apps in the EU must meet WCAG 2.1 AA. Pulse, Social, Zap, Landing all in scope. | Plan only — no audit run | Frontend teams | [[eaa]] |

## Standards we will be in scope for soon

| Standard | Trigger | Plan |
|---|---|---|
| **PCI-DSS SAQ-A** (initially) | First paid Pulse ticket. Use Stripe-hosted checkout / Elements so we never touch PAN; SAQ-A keeps us out of full PCI scope. | Decision recorded in Deferred Decisions; revisit when ticketing exits "deferred". |
| **EU AI Act** | Zap M5 "AI view" + Pulse "AI prompt filter" + Zap M4 "AI-assisted locality query". Most use cases are limited-risk (transparency obligations only), but the locality-query path could hit a high-risk category if it routes to public-safety / emergency content. | Capture in a future `wiki/compliance/ai-act.md` once Zap M5 spec firms up. |
| **State privacy laws** (VCDPA / CTDPA / TDPSA / CPA / UCPA / OCPA / DPDPA / FDBR / TIPA) | US users in those states; thresholds vary. The CCPA-shaped DSAR + opt-out infrastructure satisfies most of these — `[[ccpa]]` calls out the deltas. | Roll into `[[ccpa]]`. |
| **Brazil LGPD / Canada PIPEDA / Australia Privacy Act / Switzerland nFADP** | Users in those jurisdictions. Each is GDPR-shaped with local deltas. | Single future `wiki/compliance/non-eu-privacy-laws.md` page when traffic justifies. |

## Standards we are explicitly NOT in scope for

| Standard | Why not |
|---|---|
| **HIPAA** | We do not process Protected Health Information. If a future health-adjacent feature lands, re-evaluate. |
| **FedRAMP / IL-x / CJIS** | We do not target US federal / DoD / law-enforcement workloads. |
| **PCI-DSS SAQ-D** | We hand off all card data to Stripe (planned). SAQ-A is the most we should ever need. |
| **ISO 27001** | Overlaps SOC 2. Defer until a customer specifically requires it. |

## Cross-cutting documents

- [[scope-matrix]] — which standard applies to which user / surface, and why
- [[data-map]] — every personal-data field, its purpose, lawful basis, retention, and recipients
- [[subprocessors]] — third parties that touch personal data (Cloudflare Email, Photon geocoder, Grafana Cloud, Redis provider, Supabase) — required by GDPR Art. 28 + CCPA + SOC 2 vendor mgmt
- [[retention]] — retention schedule per data class (sessions, security events, logs, traces, metrics, deleted-account tombstones)
- [[dsar]] — operational runbook for Data Subject Access Requests (export + erasure + rectification)
- [[breach-response]] — 72-hour GDPR notification clock, customer notification SLA, the runbook
- [[access-control]] — SOC 2 CC6: who has prod access, how it is granted / revoked / reviewed
- [[backup-dr]] — SOC 2 A1: backup cadence, restore drills, RTO / RPO targets

## How to use this directory

- **Building a new feature?** Read `[[data-map]]` to see whether your feature
  introduces a new data class. If it does, add a row before merging — most
  obligations attach at "we collect this field for this purpose" granularity.
- **Adding a new third-party service?** Add a row to `[[subprocessors]]` and
  flag it on the PR. Vendor diligence + DPA must be on file before we ship.
- **Reviewing security?** The `/review-security` slash command (see
  `.claude/commands/review-security.md`) now includes a compliance checklist
  — DSAR coverage, retention windows, log redaction of PII, lawful basis
  for new collection, etc.
- **Triaging a finding?** Compliance findings use the `C-` prefix (see
  `[[review-findings]]`); track in the Compliance Backlog section of
  `[[TODO]]`.
