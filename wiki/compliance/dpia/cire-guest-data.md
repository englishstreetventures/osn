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
  - "[[cire-plus-ones]]"
last-reviewed: 2026-09-27
---

# DPIA — Cire guest data

A Data Protection Impact Assessment (GDPR Art. 35) for the cire
wedding-invite app. This processing needs a DPIA because it
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
`DIETARY_CONSENT_VERSION`, currently `"2026-09-17"`; migration `0012_dietary_consent.sql`)
evidences the condition. The lawful-processing blocker is therefore **closed**;
final sign-off now turns only on the residual retention gaps (C-H1) below.

> **Label note.** This finding is labelled **C-H2 (cire dietary)** to
> disambiguate it from the root **C-H2** (OSN account-erasure endpoint), which
> is a separate finding in `englishstventures/osn-tracker`.

## 1. Description of the processing

- **What.** A wedding organiser (the couple) uploads a guest list to cire.
  Guests open a household claim code (`families.public_id`) on a public,
  general-adult-audience site and submit an RSVP, optionally including
  **dietary requirements**, held in two columns: `rsvps.dietary_presets`, a
  closed sixteen-entry vocabulary the guest picks from, and `rsvps.dietary`,
  free text for anything the vocabulary has no key for. See [[data-map]] for
  the full field list and [[cire-auth]] for the two-auth model.
- **Organiser-recorded RSVPs (PR 5b).** An organiser (owner/editor co-host)
  may ALSO record a **phone/paper RSVP on a guest's behalf** —
  `PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId` —
  writing the SAME `rsvps` row the guest form writes (upsert on
  `(guest_id, event_id)`; last-writer-wins). Such rows carry
  `rsvps.consent_source = 'organiser_attested'` (default `'guest'`); a guest's
  own reply is `'guest'`. This is the writer attribution AND the consent-basis
  in one column — see §2 (lawful basis) for the Art. 9 story of the
  organiser-attested variant.
- **Plus-ones (migration 0066).** An editor co-host may let a guest bring a
  plus-one (`guests.plus_one_allowed`). The household then types the
  plus-one's name on the invite, and the plus-one becomes an ordinary `guests`
  row pointing at the guest who brought them (`guests.plus_one_of_guest_id`),
  able to carry an RSVP like any member. This is the one place cire holds
  personal data **supplied by another guest** rather than by the organiser or
  the person themselves: the plus-one's name, and in time their reply. Their
  replies carry `rsvps.consent_source = 'inviter_attested'`. See §2 for the
  consent basis and [[cire-plus-ones]] for the contract.
- **Data classes.** Family + guest names, RSVP status, the guest claim code
  (a credential), the guest session, and — the focus of this DPIA — the dietary
  fields `rsvps.dietary_presets` and `rsvps.dietary`. Raw organiser spreadsheets are stored in
  R2 (`cire-sheets`). All in cire's **own** Cloudflare D1 + R2, separate
  from `osn/db`.
- **Roles.** The organiser is the **controller** of guest data (they decide
  to collect it and what it contains); OSN/cire is the **processor**
  providing the platform. The organiser is themselves an OSN data subject.
- **Scale.** Per-wedding guest counts (tens to low hundreds today; multi-tenant
  scaffold allows many weddings). We collect special-category data from a
  meaningful fraction of the guests who RSVP.
- **Subprocessors.** Cloudflare (D1 + R2 store) and — on the guest site,
  **desktop-only and opt-in only** — Pinterest's `pinit_main.js` embed (touch
  devices get a plain link-out to Pinterest with no embed and no tracker). See
  [[subprocessors]].

## 2. Necessity and proportionality

- **Purpose.** Catering for guests' dietary needs is a genuine, limited
  purpose of a wedding RSVP. Collecting the data is necessary to serve it.
- **Data minimisation.** The field is optional and free-text. Free text is
  proportionate (dietary needs vary widely) but carries the risk that
  guests volunteer more than needed (e.g. naming a medical condition). The
  form copy should ask only for dietary requirements, not reasons.
- **Who can widen the recipient set (2026-08-01).** Adding a co-host moved from
  owner-only to `weddingEditor()`, so an `editor` can seat another OSN account —
  and every seat, at any role, reads this field plus the household claim codes.
  Assessed as acceptable: `editor` is the ceiling anyone can grant (no seat
  outranks its creator), removal and demotion stay owner-only, seats are capped
  per wedding below the list's read ceiling so the owner's view can never
  silently truncate, and each row records who created it. **Residual:** a new
  seat is live immediately with no notification to the owner, so "the owner can
  always revoke it" depends on them noticing. Tracked as `S-M2` in
  `englishstventures/osn-tracker`; the mitigation is an owner notification on a
  seat created by someone else.
- **Granularity (2026-08-01).** The field is stored per **(guest, event)** — a
  guest answers once per event they are invited to — and `GET …/rsvps.csv` now
  discloses it that way, one dietary column per event. It previously collapsed
  to a single column holding the first non-empty note per guest, which
  *under-reported* the data held rather than minimising it: the other events'
  answers stayed in the database and simply never appeared in the export. The
  per-event shape is the honest disclosure and is the more minimised one at the
  point of use — each event's caterer reads that event's requirement rather than
  a cell that silently mixed two events' answers.
- **Lawful basis.** Art. 6(1)(a) consent for the dietary field; the
  special-category condition is **Art. 9(2)(a) explicit consent** —
  **now captured at the RSVP form via an explicit opt-in checkbox + a stored
  server-stamped consent record** (C-H2 (cire dietary), shipped PR #123). Other
  guest fields rest on Art. 6(1)(f) (organiser-controlled wedding
  administration) per [[data-map]]. Explicit consent is the appropriate
  Art. 9 condition because no employment/vital-interest/substantial-public-
  interest condition applies to a wedding RSVP.
  - **One consent per submission (2026-09-17).** The affordance is asked once
    per reply rather than once per guest: a household of four offering dietary
    data ticks one box, not four saying the same thing. Three properties make
    that collapse lawful rather than merely convenient. The box **names every
    member it covers** ("…for Ana and Ravi"), so the consent stays specific
    about whose data it authorises. It is **unticked by default**, and submit is
    blocked until a human ticks it. And it **may only open pre-ticked when every
    member it covers already has a stored consent record** — one person's prior
    consent never carries another's, so a household where anyone is new to
    consent is asked afresh. The evidence is unchanged: the server still stamps
    `dietary_consent_at` / `dietary_consent_version` on each affected row
    individually, so the stored record is still per-guest.
  - **Re-consent by prefill.** Because the box opens pre-ticked for a household
    already covered, a guest who reopens a saved reply and changes only their
    status re-submits with it ticked and the server re-stamps the current
    version. That is defensible — the current wording is on screen, ticked,
    beside the data it authorises — and it is recorded here rather than left for
    a reader to deduce.
  - **Not the cookie-consent framework.** Moving this into the site-wide
    consent framework (`cire/invites/src/lib/consent/`, see
    [[cire-consent]]) was considered and rejected. That framework is an
    ePrivacy cookie instrument: category-level granularity, opt-out defaults
    for `embeds` and `functional`, and a client-writable cookie the guest can
    clear. None of those can carry Art. 9(2)(a) *explicit* consent specific to
    a named purpose, satisfy the Art. 7(1) duty to demonstrate it, or express
    per-guest consent from a per-browser store — and the organiser-attested
    path has no guest browser at all.
  - **Organiser-attested variant (PR 5b).** When an organiser records a
    phone/paper RSVP with dietary text, the guest is not present to tick the
    form opt-in. The Art. 9(2)(a) condition is instead met by the **organiser's
    explicit attestation** that the guest consented to storing their dietary
    requirements: the record UI gates the dietary field behind an "I confirm the
    guest consented…" checkbox (mirroring the guest opt-in), and the API rejects
    (422) any non-empty dietary submitted without it — identical to the guest
    path. The row is stamped `consent_source = 'organiser_attested'` alongside
    the same server-set `dietary_consent_at` / `dietary_consent_version`
    evidence, so the stored record distinguishes **guest-given** from
    **organiser-attested** consent (who asserted it, when, which copy version).
    The organiser (as the wedding **controller** — §1 Roles) is accountable for
    the truth of the attestation; cire (processor) captures it. No new
    subprocessor, no new data class beyond the `consent_source` discriminator.
  - **Inviter-attested variant (migration 0066).** A plus-one's reply is typed
    by the household that brought them, and stamped
    `consent_source = 'inviter_attested'`. It is not the `'guest'` case, even
    though one household member already ticks consent for another there
    (above): every member of a household is on the organiser's list, holds the
    household's claim code, and can open the invite and its privacy notice
    themselves. A plus-one does none of that — their identity itself comes from
    another guest, and they may never see the invite. So the household's tick
    for a plus-one is an **attestation** that the plus-one agreed, like the
    organiser's, not a consent the plus-one gave. **Until the invite shows
    wording that says so, the API refuses dietary data on a plus-one's reply**
    (422 `plus_one_dietary_unavailable`); a status-only reply is accepted. When
    that wording ships it gets a consent version of its own, so the stored
    record pins the attestation copy rather than the guest's own-consent copy.
    The organiser remains controller and accountable; the household is the
    attester.
  - **Art. 14 notice for a plus-one.** Their data is not obtained from them, so
    the controller owes them the Art. 14 information. The plus-one capture copy
    on the invite asks the household to pass the privacy notice (`/privacy`) to
    their plus-one; the organiser, as controller, answers their requests (see
    [[dsar]]). Name alone (Art. 6(1)(f), wedding administration) rests on the
    same basis as every other guest name.
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
| A plus-one's name and reply held on another guest's word, and they may never see the notice | Medium | Low–Medium | The household names the plus-one; the plus-one never holds the claim code. Mitigated: dietary data on a plus-one's reply is refused until attestation wording ships; the capture copy asks the household to pass on the privacy notice; the household can remove the plus-one until the RSVP deadline and the organiser at any time (permission off with the remove flag); swept with the household at 1 year ([[retention]]). |
| Guest claim code (`public_id`) leaking — it is a credential | Low–Medium | Medium | Rate-limited claim endpoint; redacted in logs (C-M2). Still a shared, low-entropy-looking string. |
| Guest data in operator logs | Low | Medium | `@cire/api` has no redacted logger yet (C-M2); deny-list is the interim guard for cross-service logs only. |
| Third-party (Pinterest) exposure of guest IP/UA/behaviour | Low | Low–Medium | Consent-gated under the site-wide `embeds` category (opt-out, persisted), on every device; an outbound link replaces the board whenever it is not showing — refused, blocked or timed out; DPA/transfer basis TODO ([[subprocessors]]). |

## 4. Mitigations

- **C-H2 (cire dietary) — RESOLVED (PR #123).** The RSVP form shows an
  explicit, unticked opt-in checkbox with clear text (linking the `/privacy`
  notice) once dietary text is entered, gates submit on it, and the API rejects
  (422) any non-empty dietary submitted without consent. A consent record is
  **persisted and server-stamped** — `rsvps.dietary_consent_at` +
  `rsvps.dietary_consent_version` (server-set to `DIETARY_CONSENT_VERSION`,
  currently `"2026-09-17"`; migration `0012_dietary_consent.sql`) — so the
  Art. 9(2)(a) condition is evidenced (who/when/which copy version). This was
  the gating mitigation for sign-off and is now in place. **PR 5b extends the
  same gate to organiser-recorded RSVPs**: the record UI shows an "I confirm the
  guest consented…" attestation checkbox gating the dietary field, the API 422s
  a non-empty dietary without it, and the row is stamped
  `rsvps.consent_source = 'organiser_attested'` (migration
  `0037_rsvp_consent_source.sql`; default `'guest'` back-fills legacy rows) so
  guest-given vs organiser-attested consent stay distinguishable in the stored
  evidence + the RSVP report ("Recorded By" column / dashboard badge).
- **Plus-ones (migration 0066).** A plus-one's reply is stamped
  `consent_source = 'inviter_attested'`, distinct from a guest's own and an
  organiser's, so the stored evidence says who attested. The API refuses
  dietary data on a plus-one's reply until the invite carries wording for that
  attestation and its own consent version. Turning a guest's permission off
  where a plus-one is named is refused unless the organiser also asks for the
  plus-one to be removed, so a plus-one's data is never deleted — or kept past
  its permission — without an explicit choice.
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
- **Minimisation by vocabulary (2026-09-17).** The form's primary control is a
  closed sixteen-entry list rather than a text box, and the text box appears
  only once a guest picks "Other". This is a stronger minimisation control than
  copy alone: it collects the requirement without offering a place to explain
  it, so a guest who would have written "coeliac, diagnosed last year" now taps
  *Gluten / coeliac*. The vocabulary also separates **diet** from **allergy**,
  which is the distinction a caterer acts on, so the organiser gets a countable
  answer from the same or less data. Rows written before the picker keep their
  prose; nothing back-fills it into keys, because inferring which keys a
  sentence meant would be the kind of guess this control exists to remove.
- **Accuracy across a vocabulary change (Art. 5(1)(d)).** The vocabulary
  grows on the server first, and a guest's open page keeps the build it
  loaded with, so a saved reply can carry a key that page does not know.
  The guest invite and the organiser portal keep such a key through an edit
  and send it back with the reply, so changing one answer never erases
  another. They also show it, labelled from the key itself (`presetLabel` in
  `@cire/dietary`: `no_pork` reads "No pork"). On the guest sheet it is a
  checked pill after every known one — at the end of the scrolling track on
  a phone — which the guest can untick, so the consent box's "the dietary
  requirements above" names something the guest can find. On the organiser
  portal it appears in the table cell, the search and the picker's
  summary, so a row whose only answer is such a key no longer reads as "no
  requirement". The label made from the key can be vaguer than the one a
  newer build carries (`gluten` would read "Gluten", not "Gluten /
  coeliac") until the page reloads. The CSV export is built by the server,
  which knows every key, so it always carries the full label.

### C-M1 (2026-08-02) — the household session now auto-discloses, and cannot be ended

**What changed.** `GET /api/claim/session` (branch `claude/invite-code-gating-hints-g8nw0o`)
lets the guest site re-open an invite from an existing `cire_session` cookie.
Before it, `cire_session` was in practice a *write* capability: the invite UI is
gated on a claim result that only `POST /api/claim` could populate, so a
returning visitor saw the code form regardless of the cookie. After it, opening
the page renders the full household payload — guest names, per-event dietary
free text (Art. 9), the couple's private closing note — with **zero
interaction**, for the cookie's 30-day life.

**Why this is a change in risk (Art. 35(11)).** The DPIA's risk analysis and the
"household-mediated" characterisation in [[scope-matrix]] both rest on the claim
code being the gate. Automatic disclosure on page load is a different disclosure
model, and the device assumption it depends on — that the browser belongs to the
household — is weakest exactly where this product is used: a family tablet, a
phone handed to a relative, a venue kiosk, a hotel business centre.

**Assessed residual risk: not high.** The disclosure is to a device the
household itself authenticated, the payload is unchanged in content (no new
field, no new recipient class — see C-L1 in [[data-map]]), and the scope is one
household. Art. 36 prior consultation is not triggered.

**Mitigations in place on the branch.**

- The payload is `Cache-Control: no-store` + `Vary: Origin, Cookie`, so no
  shared cache can retain or replay it to another household (S-H1).
- The restore is bound to the wedding being rendered via `sessionOwnsWedding`,
  so a session cannot disclose one household's data inside another wedding's
  page (S-M1).
- Deactivating a family still deletes its sessions in the same commit, and the
  restore re-checks `deactivated_at` independently.

**Outstanding mitigation — required, tracked as S-M2 in `englishstventures/osn-tracker`.**
There is no guest sign-out: `sessionService.revoke` exists but is wired to no
guest-facing route, and the guest site offers no session control at all. A
credential that auto-exercises itself needs a user-controlled way to stop it.
The planned fix is `POST /api/claim/signout` plus a "Not the <name> family?"
control on the restored invite. Until it ships, the only ways to end a session
are organiser-initiated (deactivate / remint) or 30-day expiry. Whether 30 days
remains the right TTL for an auto-exercised cookie should be decided alongside it.

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
