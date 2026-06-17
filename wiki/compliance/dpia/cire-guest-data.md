---
title: DPIA — Cire guest data (special-category dietary)
tags: [compliance, gdpr, dpia, weddings, special-category]
related:
  - "[[index]]"
  - "[[gdpr]]"
  - "[[data-map]]"
  - "[[retention]]"
  - "[[dsar]]"
  - "[[subprocessors]]"
  - "[[cire]]"
  - "[[cire-auth]]"
last-reviewed: 2026-06-17
---

# DPIA — Cire guest data

A Data Protection Impact Assessment (GDPR Art. 35) for the cire
wedding-invite app. A DPIA is triggered here because the processing
involves **special-category data** (Art. 9 — dietary free-text reveals
religion and health) about **guests at scale** who are not the controller's
direct users, which meets the Art. 35(3) / EDPB criteria (sensitive data +
data subjects in a position of asymmetry relative to the controller).

**Status: gating mitigation resolved; sign-off pending on the residual
C-H1 items.** This is the initial assessment filed with the cire merge. The
dietary-consent affordance it depended on — **C-H2 (cire dietary)** — **shipped
in this session (PR #123)**: the RSVP form now captures explicit Art. 9(2)(a)
consent via an unticked opt-in checkbox, the API rejects (422) any non-empty
dietary submitted without it, and a server-stamped consent record
(`rsvps.dietary_consent_at` + `dietary_consent_version`, default
`DIETARY_CONSENT_VERSION = "2026-06-17"`; migration `0012_dietary_consent.sql`)
evidences the condition. The lawful-processing blocker is therefore **closed**;
final sign-off now turns only on the residual retention gaps (C-H1) below.

> **Label note.** This finding is labelled **C-H2 (cire dietary)** to
> disambiguate it from the root Compliance Backlog **C-H2** (OSN account-erasure
> endpoint), which is a separate finding tracked in `[[TODO]]`.

## 1. Description of the processing

- **What.** A wedding organiser (the couple) uploads a guest list to cire.
  Guests open a household claim code (`families.public_id`) on a public,
  general-adult-audience site and submit an RSVP, optionally including
  **free-text dietary requirements** (`rsvps.dietary`). See [[data-map]] for
  the full field list and [[cire-auth]] for the two-auth model.
- **Data classes.** Family + guest names, RSVP status, the guest claim code
  (a credential), the guest session, and — the focus of this DPIA — the
  free-text `rsvps.dietary` field. Raw organiser spreadsheets are stored in
  R2 (`cire-sheets`). All in cire's **own** Cloudflare D1 + R2, separate
  from `osn/db`.
- **Roles.** The organiser is the **controller** of guest data (they decide
  to collect it and what it contains); OSN/cire is the **processor**
  providing the platform. The organiser is themselves an OSN data subject.
- **Scale.** Per-wedding guest counts (tens to low hundreds today; multi-tenant
  scaffold allows many weddings). Special-category data is collected from a
  meaningful fraction of guests who RSVP.
- **Subprocessors.** Cloudflare (D1 + R2 store) and — on the guest site,
  opt-in only — Pinterest's `pinit_main.js` embed. See [[subprocessors]].

## 2. Necessity and proportionality

- **Purpose.** Catering for guests' dietary needs is a genuine, limited
  purpose of a wedding RSVP. Collecting the data is necessary to serve it.
- **Data minimisation.** The field is optional and free-text. Free text is
  proportionate (dietary needs are heterogeneous) but carries the risk that
  guests volunteer more than needed (e.g. naming a medical condition). The
  form copy should ask only for dietary requirements, not reasons.
- **Lawful basis.** Art. 6(1)(a) consent for the dietary field; the
  special-category condition is **Art. 9(2)(a) explicit consent** —
  **now captured at the RSVP form via an explicit opt-in checkbox + a stored
  server-stamped consent record** (C-H2 (cire dietary), shipped PR #123). Other
  guest fields rest on Art. 6(1)(f) (organiser-controlled wedding
  administration) per [[data-map]]. Explicit consent is the appropriate
  Art. 9 condition because no employment/vital-interest/substantial-public-
  interest condition applies to a wedding RSVP.
- **Retention.** Tied to the wedding lifecycle; see [[retention]]. A daily
  **1-year guest-data sweep now exists** (`retentionService.sweepExpiredGuestData`,
  PR #132): `rsvps` (incl. dietary + its consent record), `guests`, `families`,
  and `imports` rows are deleted for any wedding whose final event is >365 days
  past. The residual C-H1 gap is the R2-object follow-up (uploaded sheets carry
  guest PII; not yet reaped).

## 3. Risks to data subjects

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| Special-category data collected without a valid Art. 9(2)(a) consent affordance | **Low (residual)** | High | **RESOLVED — C-H2 (cire dietary), PR #123.** The RSVP form now shows an explicit, unticked opt-in checkbox once dietary text is entered, the API rejects (422) any non-empty dietary without consent, and a server-stamped consent record (`rsvps.dietary_consent_at` / `dietary_consent_version`) evidences the Art. 9(2)(a) condition. Collection is now lawful. |
| Dietary free-text reveals more than intended (religion, medical condition) | Medium | Medium | Free-text invites over-disclosure; mitigated by form copy + minimisation guidance, not technically enforceable. |
| Indefinite retention of guest PII + raw CSVs (incl. across reverts) | High | Medium | No purge / R2 lifecycle yet (C-H1). Storage-limitation breach over time. |
| Cross-DB deletion orphan — OSN-account deletion does not erase cire guest data | Medium | Medium | No fan-out; orphan-tolerance documented in [[dsar]] (C-M1). |
| Guest claim code (`public_id`) leaking — it is a credential | Low–Medium | Medium | Rate-limited claim endpoint; redacted in logs (C-M2). Still a shared, low-entropy-looking string. |
| Guest data in operator logs | Low | Medium | `@cire/api` has no redacted logger yet (C-M2); deny-list is the interim guard for cross-service logs only. |
| Third-party (Pinterest) exposure of guest IP/UA/behaviour | Low | Low–Medium | Consent-gated opt-in, session-scoped, fallback link always present; DPA/transfer basis TODO ([[subprocessors]]). |

## 4. Mitigations

- **C-H2 (cire dietary) — RESOLVED (PR #123).** The RSVP form shows an
  explicit, unticked opt-in checkbox with clear text (linking the `/privacy`
  notice) once dietary text is entered, gates submit on it, and the API rejects
  (422) any non-empty dietary submitted without consent. A consent record is
  **persisted and server-stamped** — `rsvps.dietary_consent_at` +
  `rsvps.dietary_consent_version` (server-set to `DIETARY_CONSENT_VERSION`,
  currently `"2026-06-17"`; migration `0012_dietary_consent.sql`) — so the
  Art. 9(2)(a) condition is evidenced (who/when/which copy version). This was
  the gating mitigation for sign-off and is now in place.
- **C-H1.** Implement the wedding-lifecycle purge, the expired-`cire_session`
  sweeper, and an R2 lifecycle rule that also fires on import revert. See
  [[retention]].
- **C-M1.** Resolve the cross-DB DSAR/deletion path (ARC bridge) or re-affirm
  orphan-tolerance with a privacy-notice disclosure when `DELETE /account`
  lands. See [[dsar]].
- **C-M2.** Cire PII field names + `cire_session` added to the log-redaction
  deny-list now (interim guard); adopt `@shared/observability` in
  `@cire/api` to gain a redacted logger + RED metrics + `/health`. See
  [[soc2]].
- **Minimisation copy.** RSVP form asks for dietary *requirements* only; no
  free-text prompt that invites medical detail.

## 5. Consultation

No supervisory-authority prior consultation (Art. 36) is required: the
C-H2 (cire dietary) mitigation is now in place — explicit consent + a stored
consent record gate the field, so residual risk is not "high". (Had the
dietary field shipped without consent, Art. 36 consultation would have been
mandatory.)

## 6. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO / privacy owner | <pending> | **Pending** — gating C-H2 (cire dietary) consent capture resolved (PR #123); confirm residual C-H1 retention posture | — |
| Cire engineering owner | <pending> | Pending | — |

**Outcome: the lawful-processing blocker is closed — `rsvps.dietary` may now
be collected in production behind the shipped explicit-consent gate (C-H2 (cire
dietary), PR #123).** Re-review this DPIA when the residual C-H1 retention items
close, and at each material change to the guest data flow.
