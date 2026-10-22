---
title: DPIA — Cire guest data (special-category dietary)
tags: [compliance, gdpr, dpia, weddings, special-category]
related:
  - "[[cire-run-sheet]]"
  - "[[index]]"
  - "[[gdpr]]"
  - "[[data-map]]"
  - "[[retention]]"
  - "[[dsar]]"
  - "[[subprocessors]]"
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[cire-plus-ones]]"
last-reviewed: 2026-10-26
---

# DPIA — Cire guest data (special-category dietary)

A Data Protection Impact Assessment (GDPR Art. 35) for the cire
wedding-invite app. This processing needs a DPIA because it
involves **special-category data** (Art. 9 — dietary free-text reveals
religion and health) about **guests at scale** who are not the controller's
direct users, which meets the Art. 35(3) / EDPB criteria (sensitive data +
data subjects in a position of asymmetry relative to the controller).

**Status: gating mitigation resolved; sign-off pending on the residual
retention items.** This is the initial assessment filed with the cire merge. The
dietary-consent affordance it depended on — **shipped
in this session (PR #123)**: the RSVP form now captures explicit Art. 9(2)(a)
consent via an unticked opt-in checkbox, the API rejects (422) any non-empty
dietary submitted without it, and a server-stamped consent record
(`rsvps.dietary_consent_at` + `dietary_consent_version`, default
`DIETARY_CONSENT_VERSION`, currently `"2026-09-17"`; migration `0012_dietary_consent.sql`)
evidences the condition. The lawful-processing blocker is therefore **closed**;
final sign-off now turns only on the residual retention gaps below.

> **Label note.** This page names findings by topic. The OSN account-erasure item in [[gdpr]] once used the same kind of number, so the topic names tell the two apart.

## 1. Description of the processing

- **What.** A wedding organiser (the couple) uploads a guest list to cire.
  Guests open a household claim code (`families.public_id`) on a public,
  general-adult-audience site and submit an RSVP, optionally including
  **dietary requirements**, held in two columns: `rsvps.dietary_presets`, a
  closed sixteen-entry vocabulary the guest picks from, and `rsvps.dietary`,
  free text for anything the vocabulary has no key for. See [[data-map]] for
  the full field list and [[cire-auth]] for the two-auth model.
- **Member attribution (migration 0075, every guest household but a wedding
  listed in `CIRE_MEMBER_STEP_EXCLUDED_WEDDING_IDS`, where it stays behind
  `cire.account-linking`).** A claim
  code proves a household, not a person. After a claim the invite asks "Who
  are you?" (a household of one is chosen for) and the session records the
  member (`sessions.member_guest_id`); every reply records the member who sent
  it (`rsvps.submitted_by_guest_id`, plus `submitted_via_link` when sent while
  signed in to that member's linked musubi account, only where
  `cire.account-linking` is on) and every change-log row its actor
  (`rsvp_changes.actor_guest_id`). The household sees "Answered by
  {first name}" under each reply; the organisers see the same rows, each with
  "Answered by {first name}", and a "linked musubi" mark where
  `submitted_via_link` is set. Ids only, kept as long as the row they sit on.
  Deleting a member nulls the id on `rsvps` and `sessions`; on `rsvp_changes`
  it stays, with no foreign key, until the row ages out at 90 days
  ([[retention]]). Basis Art. 6(1)(f), wedding administration, as
  `rsvps.status`. The choice is the guest's word, backed by the household
  code: the household trust model the claim has always had. The guest privacy
  notice lists which member sent each reply.
- **Seat assignments (migrations 0089 and 20261026040620, a Gold
  module).** An organiser may set out tables for an event and seat invited
  guests at them (`seating_assignments`), in up to five versions of the chart
  per event (`seating_plans`), one of them in use. A seat says who sits beside
  whom, so it can imply a relationship; it holds ids only and no answer, is
  read by the wedding's owners and co-hosts, and is never shown to other
  guests. A guest may have a seat in each plan, so a plan nobody uses still
  holds that inference until it is deleted. An owner may download the plans in
  use (`seating.csv`: names, household, table, reply, no dietary data) and
  anyone who reads the chart may print the plan in use, for the venue. Basis Art. 6(1)(f),
  wedding administration, as the guest list it is drawn from. Seats in every
  plan go with the guest's invitation and with the 1-year guest-data sweep
  ([[retention]]); the guest privacy notice lists them.
- **Relayed dietary consent.** A household member often answers for others,
  and the sheet asks for consent once per submission. The record now shows
  which member ticked the box for whom, which makes visible a gap that already
  existed: one adult relaying another adult's health or religious data. The
  consent gate is unchanged — a household member relays the consent of the
  members they answer for, on their word. The submitter column holds an id,
  never dietary content. Revisit if an organiser or guest asks for a
  per-person step.
- **Organiser-recorded RSVPs (PR 5b).** An organiser (owner/editor co-host)
  may ALSO record a **phone/paper RSVP on a guest's behalf** —
  `PUT /api/organiser/weddings/:weddingId/guests/:guestId/rsvps/:eventId` —
  writing the SAME `rsvps` row the guest form writes (upsert on
  `(guest_id, event_id)`; last-writer-wins). Such rows carry
  `rsvps.consent_source = 'organiser_attested'` (default `'guest'`); a guest's
  own reply is `'guest'`. This is the writer attribution AND the consent-basis
  in one column — see §2 (lawful basis) for the Art. 9 story of the
  organiser-attested variant. The two differ when an organiser changes only
  the status of a reply that holds dietary data: the column then keeps the
  basis of that data, not the writer of the status (see the organiser-attested
  variant below).
- **Plus-ones (migration 0066).** An editor co-host may let a guest bring a
  plus-one (`guests.plus_one_allowed`). The household then types the
  plus-one's name on the invite, and the plus-one becomes an ordinary `guests`
  row pointing at the guest who brought them (`guests.plus_one_of_guest_id`),
  able to carry an RSVP like any member. This is the one place cire holds
  personal data **supplied by another guest** rather than by the organiser or
  the person themselves: the plus-one's name, and in time their reply. Their
  replies carry `rsvps.consent_source = 'inviter_attested'`. See §2 for the
  consent basis and [[cire-plus-ones]] for the contract.
- **Guest email addresses (migration `20261022145310_guest_emails`).** Each guest may have one address,
  for the wedding's guest email (sending is a later change, so today no mail
  provider receives one). It makes a guest contactable, so it is a new class
  of data with its own consent record, kept beside it on the guest row:
  `email_source` says who supplied it — `guest`, given on the invite for the
  seat the household says is answering, under the guest's own tick
  (`GUEST_EMAIL_CONSENT`), or `organiser_attested`, added by an owner or
  editor in the guest editor or a spreadsheet, under their attestation that
  the guest agreed (`ORGANISER_EMAIL_ATTESTATION`) — with the time, the
  wording's version and the attesting organiser. Basis Art. 6(1)(a) either
  way: the guest's own consent, or consent the owners obtained and an
  organiser attests to on their behalf. An organiser-added address was not
  obtained from the guest (Art. 14): the attestation commits the organiser to
  passing on the guest notice, which the portal links under the box, and the
  invite shows the guest "Your hosts added this" with Change and Remove. The
  household sees only the chosen member's own address, never a list, but
  anyone holding the code who picks that member sees it — the household trust
  model that already shows every member's dietary answers. `guest` therefore
  means "given on a household session for this seat"; nothing verifies the
  inbox, and double opt-in is left to the sending work. A guest's Remove
  clears the address and its record and writes a row to the suppression list
  (`email_suppressions`), which holds a per-wedding SHA-256 of the address,
  never the address, so the withdrawal outlives the address. One seat's
  opt-out stops mail to that address for every seat holding it; only that
  seat can clear it, by giving the address again. A host may re-add a
  withdrawn address; it is stored, shown as opted out, and not mailed. Hosts
  cannot change an address a guest gave themselves, only remove it from the
  editor; a spreadsheet or a revert never touches one, and a revert never
  restores an address a guest withdrew. Plus-ones have none. See [[data-map]].
- **Data classes.** Family + guest names, RSVP status, the guest claim code
  (a credential), the guest session, each guest's email address with its
  consent record and the wedding's suppression list, and — the focus of this
  DPIA — the dietary
  fields `rsvps.dietary_presets` and `rsvps.dietary`. Raw organiser spreadsheets are stored in
  R2 (`cire-sheets`). All in cire's **own** Cloudflare D1 + R2, separate
  from `osn/db`.
- **Roles.** A wedding's owners are **joint controllers** of its guest data
  (Art. 26): every owner holds every owner power and decides alone what to
  collect and what it contains. OSN/cire is their **processor**, providing the
  platform, except for the three decisions cire takes for every wedding alike
  (retention, security posture, telemetry — [[data-map]] §Controller /
  processor note). Each owner is themselves an OSN data subject.
  **Open:** Art. 26 asks joint controllers for an arrangement setting out each
  one's duties, with its essence available to guests, and Art. 28 asks for the
  processor terms. Neither is written yet: the organiser terms do not name the
  owners' duties or a point of contact, and the guest notice
  (`cire/ui/src/guest-privacy-notice.astro`, "Who decides what") does not say a
  guest may exercise their rights against any owner.
- **Scale.** Per-wedding guest counts (tens to low hundreds today; multi-tenant
  scaffold allows many weddings). We collect special-category data from a
  meaningful fraction of the guests who RSVP.
- **Subprocessors.** Cloudflare (D1 + R2 store) and — on the guest site,
  **desktop-only and opt-in only** — Pinterest's `pinit_main.js` embed (touch
  devices get a plain link-out to Pinterest with no embed and no tracker). See
  [[subprocessors]]. The organisers' RSVP change notices add none: the change
  log (`rsvp_changes`) holds ids and a kind (and, on an organiser's
  status-save row, that organiser's profile id), never the dietary content, and the
  daily digest email through Resend carries counts only — no household or guest
  name — so no guest data reaches the mail provider ([[cire-rsvp-changes]]).

## 2. Necessity and proportionality

- **Purpose.** Catering for guests' dietary needs is a genuine, limited
  purpose of a wedding RSVP. Collecting the data is necessary to serve it.
- **Data minimisation.** The field is optional and free-text. Free text is
  proportionate (dietary needs vary widely) but carries the risk that
  guests volunteer more than needed (e.g. naming a medical condition). The
  form copy should ask only for dietary requirements, not reasons.
- **Who can widen the recipient set (2026-10-01).** Only an owner can seat
  another OSN account (`weddingOwner()` on `POST /hosts`), and every seat but a
  `helper` reads this field plus the household claim codes on screen; the CSV
  exports that carry them are owner-only. Assessed as acceptable: removal and
  demotion are owner-only too, seats are capped per wedding, owners counted,
  below the list's read ceiling so no owner's view can silently truncate, and
  each row records which owner created it. **Residual:** a new seat is live
  immediately with no notification to the other owners, so "any owner can
  revoke it" depends on them noticing. Tracked in the private findings
  tracker; the mitigation is a notification to the other owners when one of
  them seats someone.
- **Several owners (2026-10-01).** A wedding can have several owners, all
  equal, so an owner can seat another person with every owner power — the
  guest list and its dietary field, the claim codes, billing, the registry's
  payout account, and the power to remove every other seat, its creator's
  included. Assessed as acceptable: both partners owning their wedding is the
  intended model, only an owner can make an owner (an editor asking is refused
  with 403), the portal asks before granting it, owners count towards the
  per-wedding seat cap, and a wedding never loses its last owner. Mail about the wedding's data — the
  RSVP digest and the retention sweep's parting gift summary — goes to every
  owner. See [[cire-auth]].
- **A helper's run-sheet scope (2026-10-20).** A `helper` seat reads none of
  the guest data above — no guest list, dietary field, claim codes or replies
  — and an owner may now set how much of the day's run sheet that helper is
  shown: `own`, the tasks they hold, or `full`, every task and who is
  doing each one (`PUT …/hosts/:osnProfileId/run-sheet-scope`, owner only).
  Every new helper starts at `own`, any role change but helper to helper
  resets the scope to `own`, and the portal asks before it is widened, saying the helper will see who
  else is doing what. A `full` helper therefore receives the other seat
  holders' names against their tasks, and the tasks' free-text titles and
  notes, which an organiser may use to name a guest. **Those titles and notes
  may also carry a guest's dietary or health detail** ("table 4: Sam's nut
  allergy"), special-category data under Art. 9 that no guest-list gate
  covers once an organiser has written it into a task, which a `full` helper
  receives with every task on the run sheet (an `own` helper only with the
  tasks they hold); it is mitigated by widening being an
  owner's alone, behind a confirmation saying the helper will see every task,
  and by every helper starting at `own` and returning to it on a role
  change, and it is **accepted**, because the owner chose names readable to
  every helper and widening needs an owner's confirmation. **The owner chose
  (2026-10-20) that the names of the people the run sheet assigns are readable
  to every helper, `own` helpers included**, so this is a deliberate
  disclosure within the wedding team, not a leak to guard against. **The
  disclosure is live** (2026-10-21): `GET …/run-sheet` serves it, on Gold
  weddings only ([[cire-run-sheet]]). What each helper receives:
  - **`own`** — the tasks their seat holds (title, notes, status, time); for
    each person who holds those tasks with them, their seat id (a random key
    that names nothing outside this wedding) and the handle, display name and
    photo URL OSN gives them, and never their OSN profile id or role; and the
    events those tasks are linked to: name, start, end, time zone, venue
    name, **full address** and **run of show** (each item's time and label).
    The owner chose (2026-10-21) to give an `own` helper the address, since
    someone carrying the cake has to find the venue; an event's address can
    be a private home. The owner chose the same day that the run sheet shows
    each event's run of show, and that an `own` helper gets it only for the
    events their tasks link to. A run-of-show label is organiser free text
    written for guests, and may name a person ("Speeches by Sam"); it is
    already read by every invited household of the event. Nothing of any
    task, event or person not linked to their own tasks.
  - **`full`** — every task on the run sheet and who holds it (the same fields
    for each person), and every event of the wedding with the same fields,
    addresses and runs of show included.

  Never the guest list, an RSVP, a dietary answer or a claim code, and no
  event field beyond those named (no description, dress code, getting-there
  notes, guest policy or image).
  Assessed as acceptable: only an owner widens a helper, behind a
  confirmation; it never opens the guest list; a helper's response is
  narrowed on the server, not in the page, and a test pins the exact fields;
  and no task text, person's name, event address or run-of-show label is
  written to a log by the route. The names and photo URLs are held in the
  Worker's memory for at most five minutes, keyed by profile id, so a re-read
  does not ask OSN again; nothing is written. See [[cire-auth#The run-sheet
  scope]].
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
  server-stamped consent record** (shipped PR #123). Other
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
    member it covers already has a current consent record of their own** — one
    person's prior consent never carries another's, so a household where anyone
    is new to consent is asked afresh. "Their own" means a record the guest
    made (`consent_source = 'guest'`) against the current wording: an
    organiser's recording of a phone reply never opens the guest's box ticked
    (`isDietaryConsentCurrent`, `cire/api/src/services/rsvp.ts`). The evidence is unchanged: the server still stamps
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
    ePrivacy cookie instrument: one switch per third-party embed (Pinterest,
    Google Maps), both off until the guest allows them, and a client-writable
    cookie the guest can clear. None of those can carry Art. 9(2)(a) *explicit* consent specific to
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
    The version names the organiser's own wording, not the guest's:
    `ORGANISER_DIETARY_ATTESTATION` in `@cire/dietary` holds the sentence
    beside its version (currently `"organiser-2026-10-01"`), the portal renders
    that sentence and sends that version, and the API refuses (422
    `dietary_attestation_outdated`) dietary data sent with any other. Organiser
    rows stored before that version carry the guest's `"2026-09-17"`.
    The box opens unticked every time, and appears only once the organiser
    edits the dietary answer. **A save that leaves the dietary answer as it
    was is status-only**: the portal sends no dietary field, and the API sets
    the status and keeps the stored answer, its consent record and its
    `consent_source`, whoever gave them (owner decision). So a guest's own
    consent is never restamped as an attestation nobody made. Who wrote is
    kept apart from the consent basis (migration 0080): every organiser save,
    status-only included, stores the organiser's OSN profile id in
    `rsvps.recorded_by_osn_profile_id`, and an organiser's dietary consent
    record names its attester in `rsvps.dietary_attested_by_osn_profile_id`,
    so with several editor seats each write and each attestation traces to one
    person. The writer column holds the latest organiser writer only: once
    anyone saves over a row, the earlier writer is gone from it. So every
    status-only save also writes a `host_status_set` row to the RSVP change log
    naming the organiser (`rsvp_changes.actor_osn_profile_id`, migration 0084),
    in the same D1 batch as the status, and that row keeps who set the status
    for 90 days whatever is written over the reply after
    ([[cire-rsvp-changes#Organiser status saves]]). The organisers' change
    notices (card, badges, digest) never read those rows. The
    dashboard badges a host's status change on a guest's or household's reply
    as "Host-updated", and the RSVP CSV labels it "(status by organiser)"; no
    read endpoint returns any of the three profile ids. The
    household's claim payload carries one yes or no derived from
    `consent_source` (`householdReplied`: whether any of its replies is its
    own), so the invite can greet a returning household. It is a household
    total rather than a field on each row, but with one reply on file, or
    with only a host's, it does show where they came from; the household
    those replies are about is its only recipient. A household rename of a plus-one clears the attester
    with the consent record it named.
    One trade-off stands, accepted by the owner: a guest an organiser marks as
    declined keeps their stored dietary answer until the guest or an
    organiser clears it (the guest's own invite clears it when they decline).
    The RSVP export leaves the dietary cell blank for any declined reply, so
    the sheet that reaches caterers carries no requirement for someone who is
    not coming (Art. 5(1)(c)).
    **A plus-one's dietary data** may be recorded by an organiser under an
    attestation of its own, which speaks of the plus-one:
    `ORGANISER_PLUS_ONE_DIETARY_ATTESTATION` in `@cire/dietary`, currently
    `"organiser-plus-one-2026-10-01"`, worded "I confirm the plus-one consented
    to their dietary requirements being stored and shared with the caterers
    for this wedding." The portal shows it in place of the guest wording on a
    plus-one's reply and sends its version and the plus-one's full name; the
    API stores a plus-one's dietary data from the organiser only under that
    version (422 `plus_one_dietary_unavailable` for the guest wording, 422
    `dietary_attestation_mismatch` for the plus-one wording on anyone else's
    reply) and for the name the row carries now (409 `plus_one_changed`, as on
    the invite). The row is stamped `'organiser_attested'` with that version.
    The owners (as the wedding's **joint controllers** — §1 Roles) are accountable for
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
    organiser's, not a consent the plus-one gave. The invite's Respond dialog
    gives it a box of its own, apart from the household's own consent box,
    naming only the plus-ones it covers and worded as a confirmation that they
    agreed. The wording and its version are one constant
    (`PLUS_ONE_DIETARY_ATTESTATION` in `@cire/dietary`); the reply names the
    version it showed, the API stores a plus-one's dietary data only when that
    is the version it stamps (422 `plus_one_dietary_unavailable` otherwise), and
    stamps it on the row. So the stored record pins the attestation copy, never
    the guest's own-consent copy, and a guest site and API from different
    builds cannot store evidence for words that were not on screen. The reply
    also names the person the sheet showed the attestation for, and the API
    refuses (409 `plus_one_changed`) a name the row no longer carries, so a page
    opened before a rename cannot attest for the person named since. The name
    is tested inside the write itself, so a rename that commits while the save
    is in flight is refused too. **A
    household rename of a plus-one clears their dietary answers and consent
    record** in the same write, on every rename, since a new name may be a
    different person (Art. 5(1)(d)). **An organiser may record a plus-one's
    dietary data only under the organiser's plus-one attestation** (the
    organiser-attested variant above). **An organiser's status-only recording
    for a plus-one keeps the household's dietary answer, its consent record and
    `consent_source = 'inviter_attested'`**, and changes only the status (owner
    decision, englishstreetventures/osn#1251), as it does for every guest. The
    column then states the dietary data's consent basis, which is still the
    household's attestation, and no longer who wrote the status; who wrote it
    is `rsvps.recorded_by_osn_profile_id` and the save's `host_status_set`
    change-log row (above). The status is not special-category data and the
    dietary evidence stays accurate. An organiser dietary edit on a plus-one replaces the reply and
    stamps `'organiser_attested'`. A household box never opens ticked over a
    record the organiser made, so a household that re-submits its reply
    afterwards must tick its own attestation for the organiser's answer, or
    clear it; the row is then stamped `'inviter_attested'` again. The
    owners remain joint controllers and accountable; the household is the
    attester.
  - **Art. 14 notice for a plus-one.** Their data is not obtained from them, so
    the controller owes them the Art. 14 information. The invite's plus-one
    prompt asks the household to share the privacy notice (`/privacy`) with
    their guest, and the notice — the same text on the guest site's `/privacy`
    and at cireweddings.com/privacy/guests, which cireweddings.com/privacy
    links to — has a section for a
    person a guest brings: the source of their details (the guest bringing
    them, or a host who records their reply and dietary requirements for them),
    the basis for each (legitimate interest for name and RSVP; for dietary
    requirements, their explicit consent as confirmed by that guest, or by the
    host who records it), and how to correct, withdraw or delete them without a
    code of their own. When an organiser records a plus-one's dietary answer
    by phone or on paper, the controller gives the notice through that
    organiser: under the organiser's plus-one attestation the portal asks them
    to pass it on, with the line "Share our privacy notice with them:
    cireweddings.com/privacy", linked to that page in a new tab
    (`cire/host/src/components/RsvpView.tsx`). An owner who records the reply
    gives it as one of the joint controllers; an editor passes it on for the
    owners (§1 Roles). The owners, as joint
    controllers, answer their requests, and can correct a plus-one's name at any time (see
    [[dsar]]). Name alone (Art. 6(1)(f), wedding administration) rests on the
    same basis as every other guest name.
- **Retention.** Tied to the wedding lifecycle; see [[retention]]. A daily
  **1-year guest-data sweep now exists** (`retentionService.sweepExpiredGuestData`,
  PR #132): `rsvps` (incl. dietary + its consent record), `guests`, `families`,
  and `imports` rows are deleted for any wedding whose final event is >365 days
  past, and the sheets their `imports` rows name are reaped from R2 in the same
  sweep. A wedding its owners delete is purged whole 7–8 days later (later if
  the daily purge cap or a payment still settling defers it): every row by
  cascade, and its sheet and image objects ([[cire-auth#Soft-deleted weddings]]).
- **What outlives the sweep (2026-10-15).** The sweep leaves the couple a record
  of their gifts on `registry_settings.gift_summary_json`: counts of list gifts
  reserved and bought, a total and a count per currency, and **each money gift's
  amount, currency and day** (at most 200 a wedding). No household, no name, no
  note. It stays with the wedding until the couple delete it. Each per-gift line
  is a guest's personal data: unnamed, but an amount and a day match one charge
  in the couple's own Stripe account, which names the payer. Basis Art. 6(1)(f):
  the couple's interest in seeing the gifts they were given, balanced on their
  already holding every one of these facts, with the name, in their own Stripe
  and bank records — the line tells them nothing new about a guest. Every member
  of the wedding reads it, viewers included, the audience that read the named
  gift log before the sweep; the owners are emailed it. Guests are told in the
  privacy notice. See [[data-map]] and [[retention]].

## 3. Risks to data subjects

| Risk | Likelihood | Impact | Notes |
|---|---|---|---|
| Special-category data collected without a valid Art. 9(2)(a) consent affordance | **Low (residual)** | High | **RESOLVED — PR #123.** The RSVP form now shows an explicit, unticked opt-in checkbox once dietary text is entered, the API rejects (422) any non-empty dietary without consent, and a server-stamped consent record (`rsvps.dietary_consent_at` / `dietary_consent_version`) evidences the Art. 9(2)(a) condition. Collection is now lawful. |
| Dietary free-text reveals more than intended (religion, medical condition) | Medium | Medium | Free-text invites over-disclosure; mitigated by form copy + minimisation guidance, not technically enforceable. |
| Indefinite retention of guest PII + raw CSVs (incl. across reverts) | High | Medium | Mitigated: the 1-year guest-data sweep (rows and their sheets) and the purge of a deleted wedding (every row, both R2 buckets); a sheet whose delete failed is reaped by the daily `cire-sheets` reconciler within one pass over the bucket ([[retention]]). Residuals: browser copies of public images can live a year, the couple's Stripe Express account and Zap enquiry chats outlive the purge, and while an operator has the reconcilers stopped (a `reconcile/stop` object or `CIRE_R2_RECONCILE_DISABLED`, around a database restore) orphaned sheets wait for them — emailed to the operator daily, 14 days at most by the runbook. |
| Guest spreadsheets or invite photos permanently deleted by the daily R2 orphan reconciler while the rows naming them are missing — a bad migration, a wrong bulk delete, a `cire-db` restore — with no versioning or second copy of `cire-sheets` or `cire-assets` to restore from ([[backup-dr]]) | Low | High | Mitigated: only objects R2 says are 7 days old are judged; a failed or empty reference read, a database paired with another environment's bucket, or a lookup that loses its control deletes nothing; at most 500 objects a run; a run whose rows naming the bucket's objects fell by more than half holds, emails the operator, and keeps holding against the earlier count for up to 7 runs; an operator's `reconcile/stop` object stops a reconciler without a deploy, and the restore runbook in [[backup-dr]] sets it first; every delete batch logs a warning. Residuals: no backup of either bucket; a loss under half the rows is not held; a hold lasts 7 runs and a stop relies on an operator acting on the email; an empty table or a total wipe aborts every run with a warning log and sends no email. |
| Cross-DB deletion orphan — OSN-account deletion does not erase cire guest data | Medium | Medium | No fan-out; orphan-tolerance documented in [[dsar]]. |
| A guest's gift amount and day outlive the year in the couple's record | Medium | Low | Kept unnamed, with no note or Stripe identifier, a day rather than a time, at most 200 lines a wedding; read only by the wedding's members and mailed to its owners. The couple can still match a line to the payer in their own Stripe account — but they were the recipients and hold that record anyway, so the residual is that cire keeps a copy past the year. Guests are told in the privacy notice; the record goes when the couple delete the wedding. |
| A plus-one's name and reply held on another guest's word, and they may never see the notice | Medium | Low–Medium | The household names the plus-one; the plus-one never holds the claim code. Mitigated: dietary data on a plus-one's reply is stored only under an attestation that speaks of the plus-one — the household's, or the organiser's for a phone or paper reply — each in its own box and wording, pinned by its own version and to the name the plus-one carries now; a household rename clears the plus-one's dietary answers; the capture copy asks the household to pass on the privacy notice, which has a section for them, and the portal asks an organiser recording a plus-one's dietary answer to pass on cireweddings.com/privacy, which leads to it; an editor can correct the name at any time; the household can remove the plus-one until the RSVP deadline and the organiser at any time (permission off with the remove flag); swept with the household at 1 year ([[retention]]). |
| A member's reply attributed to the wrong person on a shared device | Low | Low | Anyone holding the household code can pick any member's name — the household trust model the claim has always had. Mitigated by "Not you?" (clears the member and ends the browser's musubi sign-in), by the invite naming the member answering — the write refuses a reply when the session's member is no longer the one the page showed (409 `member_changed`), so another tab's choice never takes over this tab's answers — and, where account linking is on, by musubi always showing the signed-in account before a link (`prompt=select_account`). There `submitted_via_link` lets the organisers tell "signed in as" from "picked from a list"; where it is off, every attribution is "picked from a list". |
| One household member relays another adult's dietary consent | Medium | Medium | Existing gap, now visible in the record (which member ticked the box for whom). Accepted: the consent gate is unchanged and the household relays consent on its own word; revisit on request. |
| A guest's email address used without their agreement — an organiser attests falsely, or one household member gives another's address | Medium | Medium | Every address carries who supplied it and the consent behind it: the guest's own tick, or the attestation of a named owner or editor under a versioned wording that also commits them to passing on the notice. The guest sees a host-added address on the invite, labelled as the hosts', with Remove; Remove stops mail to it for the wedding. Residuals: an attestation is the organiser's word, not proof; an address is never verified, so a mistyped or someone else's address is stored as given until sending adds confirmation. |
| A guest's address disclosed to the wrong person in the household | Low | Low–Medium | The household receives only the chosen member's own address, never a list, and only on its own session. Anyone holding the household code who picks that member's name sees it — the household trust model the dietary answers already rest on. Accepted. |
| A withdrawn address mailed anyway, or a withdrawal undone by someone else | Low | Medium | Removal writes a suppression row, in the same batch as the clear and naming the address the row held then, that sending must check; any matching row suppresses the address for every seat. Only the seat that withdrew it can clear its row, so another household saving the same address cannot undo it. A revert never restores a withdrawn address, and a host re-adding one is warned before attesting and sees it marked opted out. A seat holds at most 10 opt-outs. Residual: anyone holding a household code can block an address for the wedding by adding then removing it — this fails safe, since nobody is mailed, but neither the guest nor the hosts can clear it; an operator deletes the row by hand on request ([[dsar]]). Whether a removal must first prove the inbox is the sending work's question (englishstreetventures/osn#481). |
| The suppression hash reversed by guessing | Low | Low | It is an unkeyed SHA-256 of the wedding id and the address, so anyone holding the database and a candidate address can test it. It keeps the plain address out of the table and needs no secret whose rotation would drop every opt-out. Accepted while the change history in R2 still holds addresses in plain text for up to a year. |
| Addresses left in copies after a guest removes theirs | Medium | Low | The uploads, editor drafts, previews and before-images in `cire-sheets` keep the addresses their rows held, until the 1-year sweep, the 7-day preview sweep, the 10-change prune or the purge deletes them ([[retention]]). Not reachable from any guest-facing path. Accepted, and stated in the data map. |
| Guest claim code (`public_id`) leaking — it is a credential | Low–Medium | Medium | Rate-limited claim endpoint; redacted in logs. Still a shared, low-entropy-looking string. |
| Guest data in operator logs | Low | Medium | `@cire/api` has no redacted logger yet; deny-list is the interim guard for cross-service logs only. |
| Third-party (Pinterest) exposure of guest IP/UA/behaviour | Low | Low–Medium | Consent-gated under its own `pinterest` switch (off until allowed, persisted), on every device; an outbound link replaces the board whenever it is not showing — refused, blocked or timed out; DPA/transfer basis TODO ([[subprocessors]]). |

## 4. Mitigations

- **dietary consent gate — RESOLVED (PR #123).** The RSVP form shows an
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
  organiser's, so the stored evidence says who attested. The RSVP report keeps
  it apart too: the dashboard badges such a reply "Household-entered", the
  report's "Recorded By" column says "Household" — "Household (status by
  organiser)" once an organiser has set one of those replies' status — and a "Plus-one Of" column
  names the guest who brought them. The invite takes a plus-one's dietary
  data only behind the household's attestation box, and the API stores it
  only when the reply names the attestation version it stamps and the name
  the plus-one carries now. The organiser's route takes it only under the
  organiser's own plus-one attestation, on the same two checks. A
  household rename clears the plus-one's dietary answers and consent record.
  Turning a guest's permission off
  where a plus-one is named is refused unless the organiser also asks for the
  plus-one to be removed, so a plus-one's data is never deleted — or kept past
  its permission — without an explicit choice.
- **Guest email addresses (migration `20261022145310_guest_emails`).** An address needs its consent
  record at every door: the guest route refuses a consent version the page
  did not show (422), and an apply that sets an address on the organiser's
  word is refused without the attestation's current version (422
  `email_attestation_required`), before any write; the stamped record names
  the organiser. The editor sends an address only for a guest the organiser
  changed, with the address it loaded, and the write applies only while the
  stored address and its source are still those, so a guest's own save —
  even of the same address — is never overwritten. No address appears in a log line: `email` is a redacted key and
  no message string carries one, which `guest-email.test.ts` checks.
- **Retention.** The wedding-lifecycle purge (an owner's delete, purged 7–8 days
  later) and the expired-`cire_session` sweeper exist; an R2 lifecycle rule
  that also fires on import revert does not. See [[retention]].
- **Cross-database deletion.** Resolve the DSAR/deletion path (ARC bridge) or re-affirm
  orphan-tolerance with a privacy-notice disclosure when `DELETE /account`
  lands. See [[dsar]].
- **Log redaction.** Cire PII field names + `cire_session` added to the log-redaction
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

### Household session (2026-08-02) — now auto-discloses, and cannot be ended

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
field, no new recipient class — see [[data-map]]), and the scope is one
household. Art. 36 prior consultation is not triggered.

**Mitigations in place.**

- The payload is `Cache-Control: no-store` + `Vary: Origin, Cookie`, so no
  shared cache can retain or replay it to another household.
- The restore is bound to the wedding being rendered via `sessionOwnsWedding`,
  so a session cannot disclose one household's data inside another wedding's
  page.
- Deactivating a family still deletes its sessions in the same commit, and the
  restore re-checks `deactivated_at` independently.

**Guest sign-out — in place since 2026-08-09.** A credential that exercises
itself needs a way for the guest to stop it. `POST /api/claim/signout`
(`cire/api/src/routes/claim.ts`) clears the household cookie, revokes the
session as a best effort, and always answers 204, so a stale cookie is cleared
too. The restored invite shows a "Not the <name> family? Sign out" control
(`cire/invites/src/components/LoginSection.tsx`). An organiser can still end a
session by deactivating or reminting the family.

**Open question.** Whether 30 days (`SESSION_TTL_SECONDS` in
`cire/api/src/routes/claim.ts`) is the right lifetime for a cookie that
exercises itself on every visit.

## 5. Consultation

No supervisory-authority prior consultation (Art. 36) is required: the
The dietary consent mitigation is now in place — explicit consent + a stored
consent record gate the field, so residual risk is not "high". (Had the
dietary field shipped without consent, Art. 36 consultation would have been
mandatory.)

## 6. Sign-off

| Role | Name | Decision | Date |
|---|---|---|---|
| DPO / privacy owner | <pending> | **Pending** — gating dietary consent capture resolved (PR #123); confirm residual retention posture | — |
| Cire engineering owner | <pending> | Pending | — |

**Outcome: the lawful-processing blocker is closed — `rsvps.dietary` may now
be collected in production behind the shipped explicit-consent gate (PR #123).** Re-review this DPIA when the residual retention items
close, and at each material change to the guest data flow.
