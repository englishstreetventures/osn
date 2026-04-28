---
title: Verified Identity (Yoti-style)
tags: [identity, verification, kyc, age-assurance, selective-disclosure, sd-jwt, australia, design-doc]
related:
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[step-up]]"
  - "[[arc-tokens]]"
  - "[[compliance/gdpr]]"
  - "[[compliance/coppa]]"
  - "[[compliance/data-map]]"
  - "[[compliance/dsar]]"
packages:
  - "@osn/api"
  - "@osn/db"
  - "@osn/client"
  - "@osn/ui"
  - "@osn/social"
  - "@shared/crypto"
last-reviewed: 2026-04-28
status: design — not yet implemented
---

# Verified Identity

Design doc for a Yoti-style reusable verified-identity layer in OSN. The
goal is "verify once, present privately many times" — a user does a single
identity check (e.g. scan their Australian driver's licence + selfie),
OSN stores the derived attributes (age, name, country, …) under the
account, and any OSN app or third-party relying party can later request
**only** the specific claim it needs ("over 18", verified given-name,
country = AU) without seeing the source document.

This page captures **what we are building, why, and the staged plan**.
Nothing here is shipped yet — see the **Verified Identity (V)** section
of `[[TODO]]` for live work.

## Why

- **Pulse + Zap need age assurance now.** Australia's Social Media
  Minimum Age obligations took effect 10 Dec 2025; OSN must take
  "reasonable steps" to keep under-16s off Pulse/Zap account
  registration. A government-document round-trip on every signup is
  hostile UX; a one-time OSN verification + per-app `over_16` boolean is
  the right ergonomic.
- **Pulse hosts use cases beyond age.** "Hosts can require verified
  attendees" is a roadmap item (`[[event-access]]`), and an event host
  asking for a verified given-name should not learn the attendee's
  driver's-licence number, address, or DOB.
- **OSN already has the cryptographic substrate.** `[[arc-tokens]]`
  ships ES256 signing + JWKS distribution + a per-key revocation cache.
  Issuing **SD-JWT VC** (selectively-disclosed JWT-based verifiable
  credentials, RFC 9901 + draft-ietf-oauth-sd-jwt-vc) reuses the same
  key infrastructure — the issuer is just another `service_account`
  consumer of the OSN signing key.
- **Australia first.** The user base lives here; the regulatory clock
  is ticking here; the document/mDL stack is well-defined here. Other
  countries layer on top of the same primitives in later phases.

## Mental model

Three roles, modelled after the W3C VC role triangle but speaking
SD-JWT VC on the wire:

| Role | Who | What |
|---|---|---|
| **Issuer** | `@osn/api` + a verification provider (Persona, idvPacific, MATTR, …) | Runs the user through a verification flow once, mints SD-JWT VCs claiming the verified attributes, signs them with the existing OSN ES256 key. |
| **Holder** | The user, via `@osn/social` (and later mobile wallets) | Stores verified attributes account-side. On a presentation request, releases only the disclosures matching the requested claim set. |
| **Verifier / Relying party** | Pulse, Zap, third-party apps | Asks for a specific predicate ("`age >= 18`", "`country == AU`", "`given_name` verified"), receives an SD-JWT VC presentation, validates the OSN issuer signature against `/.well-known/jwks.json`. |

Critically: **OSN never re-shares the source document.** The licence
image is processed for OCR + face-match, the doc number is hashed for
replay/duplicate-account defence, and the raw image is destroyed within
the verification provider's retention window. Only derived attributes
+ an evidence hash live in OSN's database — Yoti's "privacy by
design" model directly.

## Verification methods (Australia)

OSN supports a layered set, picked per-attribute by required assurance:

1. **Facial age estimation** — selfie → ML age estimate → `age_band`
   attribute (e.g. `"18-24"`). Probabilistic, low friction, **not**
   sufficient for legally binding age gates above ±2 years tolerance.
   Use for: "looks adult" UX hints, soft gates.
2. **Document verification (DVS)** — capture AU driver's licence /
   passport / Medicare card → OCR → submit to the Australian
   Government's [Document Verification
   Service](https://www.idmatch.gov.au/) (yes/no match) via a gateway
   provider (idvPacific, Equifax IDMatrix, GBG) → liveness selfie →
   face-match against the licence photo. Yields `dob`,
   `given_name`, `family_name`, `country`, `document_type`,
   `document_expires_at`, `document_number_hash`.
3. **mDL acceptance (ISO 18013-5/-7)** — verify a state-issued mobile
   driver's licence presented from the user's phone. Queensland live
   since Nov 2023; NSW pilot Feb 2025; full rollout late 2026. mDL
   already supports selective disclosure natively, so the user
   transmits only the requested fields. We re-issue these as OSN
   SD-JWT VCs so downstream relying parties see one credential format.
4. **myID / AGDIS** — once the [Digital ID Act
   2024](https://www.digitalidsystem.gov.au/what-is-digital-id/digital-id-act-2024)
   opens AGDIS to private-sector relying parties (30 Nov 2026),
   accept a myID assertion as the verification source.

Other countries: same shape, swap step 2 for the local document
verification provider (Onfido / Sumsub / Veriff cover the global
catalogue) and step 3 for the local mDL issuer when one exists.

## Cryptography choice

**SD-JWT VC** for everything OSN issues. Reasons:

- Built on the JWS substrate we already operate (ES256, JWKS rotation,
  scoped audiences) — the verifier code is `verifyArcToken` with a
  different audience. See `[[arc-tokens]]`.
- Pure JSON on the wire — no CBOR/COSE binary tooling needed, fits
  Elysia + Effect cleanly.
- IETF spec landed Nov 2025 (RFC 9901); SD-JWT VC profile in WG last
  call, EU Digital Identity Wallet picked it. Bet on the same horse.
- Selective disclosure via salted-hash claims: issuer publishes the
  digest, holder decides at presentation time which cleartext claims
  to reveal. Predicates ("`age >= 18`") implemented as
  pre-computed boolean attributes minted alongside the raw `dob`,
  so we don't ship range-proof crypto in v1.

**Hard requirement: separate signing key for VCs.** Even though VC
issuance reuses the JWS substrate, the actual ES256 keypair MUST be
distinct from the ARC S2S key. Same JWKS, different `kid`. Rationale:
ARC tokens are short-lived (seconds-to-minutes) and verified
internally; VCs may live months and travel to third-party verifiers.
Cross-purpose key use is a key-confusion / cross-protocol attack
surface — a bug in `aud` enforcement on either side becomes a
privilege-escalation across both. Separate keys also give independent
rotation (rotating ARC key must not invalidate every outstanding VC)
and independent revocation. Verifiers MUST pin `kid` + `aud`
together. See `[[arc-tokens]]`.

**Not chosen for v1**:

- **BBS+ / unlinkable VC** — gives multi-presentation unlinkability
  without colluding-verifier risk. Operationally heavy; the
  unlinkability win is real but not on the critical path. Revisit if
  cross-app correlation becomes a documented threat.
- **mdoc/COSE issuance** — accept-only. We verify state-issued mDL
  presentations but re-issue the claims as SD-JWT VC so we have one
  credential format on the holder side.

Source document hashing: each verified attribute row stores
`document_number_hash = HMAC-SHA-256(pepper, provider ‖
document_type ‖ document_number)` where `pepper` is held only in
`@osn/api` env, never in the database, and is distinct per attribute
kind. Plain SHA-256 is **not** sufficient — AU driver licence numbers
are ~8 digits and AU passports ~9 alphanumeric, both well within
brute-force range from a DB read. The HMAC + env-only pepper mirrors
the IP-hash pattern in `[[sessions]]`. The schema MUST also enforce
`UNIQUE(document_number_hash)` across providers; collision response
is a generic refusal (no enumeration of which other account already
holds the document) plus a `security_event` row of kind
`identity_duplicate_document_attempted`.

## Data model

New tables in `osn/db/src/schema/`:

| Table | Purpose |
|---|---|
| `verification_providers` | Pluggable provider registry: id, name, kinds supported (`age_estimate \| dvs \| mdl \| myid`), api endpoint, credential bundle ref, status (active/draining/disabled). |
| `verification_runs` | One row per verification ceremony: id, account_id, provider_id, kind, status (`pending \| succeeded \| failed \| expired`), started_at, completed_at, failure_reason, redacted provider response (for audit, evidence images NOT stored). |
| `verified_attributes` | The derived claims: id, account_id, attribute_kind (`age_over_16 \| age_over_18 \| age_band \| dob \| given_name \| family_name \| country \| document_expires_at \| document_number_hash`), value (encrypted JSON), provider_id, verification_run_id, verified_at, expires_at, revoked_at. |
| `presentations` | Issued SD-JWT VC audit trail: jti, account_id, audience, requested_claims (JSON), released_claims (JSON), issued_at, ttl, revoked_at. |

`security_events` gets two new kinds, `identity_verified` and
`identity_presentation_issued`, mirroring the existing
`passkey_register` / `recovery_generate` audit pattern (`[[recovery-codes]]`).

Encryption-at-rest for `verified_attributes.value`: use the existing
key-management substrate (`@shared/crypto`); the decryption key lives
only in `@osn/api` so that even direct DB access does not expose raw
DOB / name. Document this in `[[compliance/data-map]]` as a Special
Category Personal Data store under GDPR Art. 9.

## Endpoints (planned)

```
POST   /identity/verify/begin         { kind: "dvs" | "age_estimate" | "mdl" | "myid" }
POST   /identity/verify/complete      { runId, providerPayload }
GET    /identity/attributes           → list of verified attributes (UI)
DELETE /identity/attributes/:kind     step-up gated; revokes that attribute
POST   /identity/presentation/request external-RP-facing; returns OAuth-style
                                      consent URL with the claim-set
POST   /identity/presentation/issue   user-facing; mints the SD-JWT VC after
                                      explicit consent + step-up
GET    /.well-known/openid-credential-issuer  metadata for OpenID4VCI
GET    /.well-known/openid-federation          (later)
```

All write paths step-up gated (`[[step-up]]`). Relying-party requests
follow OpenID for Verifiable Presentations (OpenID4VP) so we get
consent UX + `state`/`nonce`/audience binding for free instead of
inventing our own protocol.

## UI surface

In `@osn/social` Settings → Identity (new tab next to Security):

- **"Verify your identity"** — entry point listing available kinds
  (Age estimate / Australian licence or passport / mDL / myID), with
  a one-line privacy note per option ("we never see your address").
- **"Verified attributes"** — list of attributes with provenance
  ("Verified 12 Jan 2026 via NSW digital driver licence"), expiry,
  delete button. Clicking shows the underlying claim and where it has
  been presented.
- **"Connected apps requesting verification"** — the consent screen
  shown when a relying party asks for claims. Per-claim toggle
  (`age_over_18` ON, `given_name` OFF, `country` ON), explicit
  "Share these and only these" CTA, full SD-JWT VC payload in a
  developer drawer for transparency.

The UX pattern we want: **no surprises — every claim release is an
explicit single-screen consent with a plain-English summary.**

## Compliance posture

This system creates **Special Category Personal Data** under GDPR Art.
9 (biometric for unique identification + identity-document data).
Hard requirements:

- **DPIA** before M1 ships. Add to `[[compliance/gdpr]]` and link from
  `[[TODO]]` C-M3.
- **Data map** updates: new processor (KYC vendor), new categories
  (biometric template hashes, document numbers via hash), new
  retention rule (verified_attributes default 24 months from
  `verified_at` or until document expiry, whichever sooner). See
  `[[compliance/data-map]]`, `[[compliance/retention]]`,
  `[[compliance/subprocessors]]`.
- **DSAR coverage**: `verified_attributes` and `presentations` must
  appear in `GET /account/export` (C-H1) and be hard-deleted by
  `DELETE /account` (C-H2). See `[[compliance/dsar]]`.
- **DVS access**: registration with the Department of Home Affairs;
  DVS-approved consent statement shown verbatim before each DVS
  call; retain the consent record. The Australian Privacy Act 1988 +
  APP 11 also bind us once we touch this data.
- **COPPA / age gate**: a verified `age_over_16: true` attribute can
  satisfy the C-H8 hard age gate during registration, replacing the
  self-declared birthdate path.
- **DSA Art. 28**: Pulse becomes capable of credibly enforcing minor
  protections via verified age, which interacts with future Pulse
  recommender disclosures.

## Vendor shortlist (Australia)

| Vendor | Strength | Trade-off |
|---|---|---|
| **Persona** | Top-scoring vendor in the AU age-assurance trial; combined verification + estimation; Australian operations | US-domiciled |
| **idvPacific** | AU-based; OCR + DVS gateway; pricing transparent | Smaller player |
| **Equifax IDMatrix** | Established AU commercial DVS gateway | Heavier integration |
| **GBG** | Selected as MATTR's distribution partner for AU mDL acceptance (Oct 2025) | Strong on mDL, less on document capture |
| **MATTR** | mDL-native (W3C VC + ISO 18013-5/-7) | Specialised toolset |
| **Yoti** | Reference design for the whole product; reusable digital ID app | UK-domiciled; we are a competitor product |
| **Onfido / Sumsub / Veriff** | Global big three | Less AU-specific; not preferred |

**M1 recommendation**: Persona for facial age estimation (low
regulatory bar, strong trial showing). **M2 recommendation**:
idvPacific or Equifax for DVS, decided after a vendor RFP that
includes pricing, AU support, and DPA terms. **M3**: MATTR/GBG for
mDL acceptance.

## Phased plan (links into `[[TODO]]`)

The Verified Identity (V) section in `[[TODO]]` carries the live
checklist. Summary:

- **V-M0 — Foundations**: vendor + DPIA + schema + SD-JWT VC issuance
  helper (no UI, no provider yet).
- **V-M1 — Facial age estimation**: end-to-end thinnest path. Lets
  the social-media-minimum-age clock be answered.
- **V-M2 — AU document verification (DVS + selfie + face-match)**.
- **V-M3 — mDL acceptance** (NSW + QLD first; others as they go
  live).
- **V-M4 — Relying-party API + OpenID4VP consent screen**, opens
  verified attributes to Pulse/Zap and third-party apps.
- **V-M5 — myID / AGDIS** once private-sector RP eligibility opens
  (30 Nov 2026).
- **V-M6 — Other countries** (UK + EU + US first, parametrised on
  the same provider abstraction).

Each milestone ships a wiki-page update here with what landed, the
finding history, and the observability surface (counters per
verification kind + outcome, latency histograms per provider, a
`presentation.issued` event with audience attribute).

## Threat model snapshot

Captured to flag review surface, **not** to claim mitigations are
designed yet:

- **Sybil via document re-use** — `document_number_hash` blocks the
  trivial case; sophisticated attacker with multiple licences not
  defended yet.
- **Verifier collusion** — independent SD-JWT VCs are linkable by
  shared salts if the same VC is presented to two RPs. Mitigation:
  mint a fresh VC per audience (default), or move to BBS+ in v2.
- **Compromise of the OSN signing key** — same blast radius as
  ARC tokens; mitigated by the existing key-rotation + JWKS
  invalidation path.
- **Provider compromise** — a malicious KYC vendor could mint false
  verifications. Defence: stamp every `verification_run` with the
  provider id + timestamp + provider-side `runId` so OSN can revoke
  attributes per-provider on incident; require evidence-hash
  uniqueness across providers for the same `document_number_hash`.
- **Replay** — `presentations.jti` single-use store mirrors the
  step-up JTI pattern (`[[step-up]]`).

A formal STRIDE pass lands as part of V-M0.
