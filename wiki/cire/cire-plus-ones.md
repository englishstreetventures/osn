---
title: Cire plus-ones
tags: [systems, cire, rsvp, guests, compliance]
related:
  - "[[cire]]"
  - "[[cire-auth]]"
  - "[[cire-rsvp-deadline]]"
  - "[[cire-guest-event-editor]]"
  - "[[cire-entitlements]]"
  - "[[dpia/cire-guest-data]]"
  - "[[component-library]]"
  - "[[cire-invite-designs]]"
  - "[[cire-rsvp-changes]]"
last-reviewed: 2026-10-01
---
# Plus-ones

A guest may bring a plus-one when an editor co-host allows it. The household names the plus-one on the invite, and from then on the plus-one is a guest like any other: they appear in the Respond dialog, reply to their events, and count in every tally.

This page is the contract. The host permission UI, the guest capture on the invite and the host RSVP display build on it; they are described under [[#The portal]], [[#On the invite]] and [[#The RSVP table]].

---

## The shape

A plus-one is an ordinary `guests` row. Nothing else can carry an RSVP, a dietary answer or an event invitation, so nothing else would do.

| Column (`guests`, migration 0066) | On whose row | Meaning |
|---|---|---|
| `plus_one_allowed` | the permitting guest's | May bring a plus-one. Always `0` on a plus-one's own row. |
| `plus_one_of_guest_id` | the plus-one's | The guest who brought them. `REFERENCES guests(id) ON DELETE CASCADE`, unique. |

Every plus-one:

- is in the **same household** (`family_id`) as the guest who brought them;
- is invited to **exactly that guest's events** — copied when they are named, and kept equal afterwards (see [[#The change pipeline]]);
- is **one per guest, per wedding** — the unique index on `plus_one_of_guest_id` enforces it, and doubles as the probe the cascade runs on every guest delete. The index is **partial** (`WHERE plus_one_of_guest_id IS NOT NULL`): the column is NULL on almost every row, and as a full index the planner took it for `plus_one_of_guest_id IS NULL` filters and walked every wedding's guests. `tests/db/plus-one-index.test.ts` pins both halves;
- carries `source = 'manual'`, and is told apart by `plus_one_of_guest_id`, never by `source`;
- **cannot bring a plus-one** of their own.

Deleting the guest who brought them deletes the plus-one, with their replies and invitations.

---

## Who writes what

Two principals, each owning one half.

### The organiser owns the permission

Editor-gated (`weddingEditor()`; a viewer gets `403 read_only_role`), like every guest-list write. The RSVP deadline does not gate these — the organiser owns the date.

| Route | Body | Answer |
|---|---|---|
| `PUT /api/organiser/weddings/:weddingId/guests/:guestId/plus-one` | `{ allowed, removePlusOnes? }` | `{ guestId, plusOneAllowed, plusOneRemoved }` |
| `PUT /api/organiser/weddings/:weddingId/families/:familyId/plus-one` | `{ allowed, removePlusOnes? }` | `{ familyId, plusOneAllowed, guestsUpdated, plusOnesRemoved }` |
| `PUT /api/organiser/weddings/:weddingId/guests/:guestId/plus-one/name` | `{ firstName, lastName? }` | `{ plusOne }` |

- The household route writes every member's flag and skips the household's plus-ones.
- **Turning permission off deletes only plus-ones the organiser confirmed.** `removePlusOnes` lists the plus-ones the organiser was shown and agreed to remove, each as `{ guestId, firstName, lastName }` exactly as `GET …/guests` served them (default: none). The write goes through only if **every** plus-one in scope is on that list; they are then deleted, with their replies and invitations, in the same batch as the switch. Otherwise nothing is written and the answer is `409 { error: "plus_one_named", named }`, `named` being how many plus-ones are in scope now. So a plain `allowed: false` over a named plus-one is refused, and so is a confirmation that has gone stale — a plus-one named since, or renamed, since a household can replace its plus-one by renaming the row it has. A confirmed plus-one the household has already taken back does not block the write: everything deleted is still someone the organiser agreed to.
  - The check runs **inside the write batch**, which D1 commits as one transaction: the UPDATE and the DELETE each carry it, and a read of the plus-ones still in scope ends the batch and decides the answer. A plus-one named or renamed while the organiser confirms cannot slip between the check and the delete, and a plain turn-off cannot commit over a plus-one named before it.
  - Why a list and not a flag: this delete sits outside the change history — no preview, no revert — so it must never reach someone the organiser did not see. The portal sends the plus-ones its confirmation showed — see [[#The portal]].
  - The body refuses any key it does not know with a `400`, so a misspelled confirmation is an error rather than "confirms nobody", refused as `plus_one_named` on every retry.
- `404 guest_not_found` / `family_not_found` for a row outside the wedding or in the host-preview household; `409 plus_one_cannot_invite` on a plus-one's own row.
- The name route corrects the name of the plus-one `:guestId` brought (`404 plus_one_not_found` if none). It is the one organiser write to a plus-one's own row, there so a name can be put right after the deadline has locked the household out (Art. 16).

### The household owns the plus-one

Behind the household session cookie, like `POST /api/rsvp`, with no Turnstile for the same reason: the cookie came from a Turnstile-gated claim. A per-IP limiter (20 a minute, as on the guest registry writes) caps the write rate: naming and removing in a loop would otherwise spend the D1 write quota every wedding shares. `:guestId` is the member bringing the plus-one.

| Route | Body | Answer |
|---|---|---|
| `PUT /api/plus-one/:guestId` | `{ firstName, lastName? }` | `{ plusOne: { guestId, firstName, lastName, plusOneOf, eventIds }, created, dietaryCleared }` |
| `DELETE /api/plus-one/:guestId` | — | `{ removed }` (idempotent) |

`PUT` names the plus-one, or renames the one already named. **A rename that changes the name clears the plus-one's dietary answers and consent record** (`dietary`, `dietary_presets`, `dietary_consent_at`, `dietary_consent_version`) in the same D1 batch as the name — on every such rename, not only when the read before it saw answers, since a reply can land in between — and answers `dietaryCleared: true` when there were answers to clear; each reply's status stays. The household may be naming a different person — or a second device, still showing no plus-one, "adds" one over whoever is there — and the answers and the household's attestation were about the person before. The organiser's name correction is a spelling fix and clears nothing. Refusals, in the order they are checked:

| Status | `error` | When |
|---|---|---|
| 403 | `Unauthorized` | The session's household row is gone |
| 403 | `Preview sessions cannot change plus-ones` | The organiser's host preview |
| 403 | `rsvp_closed` | The RSVP deadline has passed — same predicate and instant as the RSVP write ([[cire-rsvp-deadline]]) |
| 404 | `guest_not_found` | `:guestId` is not in this household |
| 409 | `plus_one_cannot_invite` | `:guestId` is itself a plus-one |
| 403 | `plus_one_not_allowed` | No permission (`PUT` only — taking a plus-one back needs none) |
| 409 | `guest_capacity` | Naming one would pass the guest cap the wedding's plan tier gives it ([[cire-entitlements]]) |
| 429 | — | The per-IP limiter's budget is spent |

Names are trimmed and at most 100 characters each. They may not contain control, format or separator characters (Unicode `Cc`, `Cf`, `Zl`, `Zp` — zero-width spaces, direction marks and overrides among them — save the zero-width joiner and non-joiner some scripts need) or the letters that render blank. A first name must contain a letter or digit, so it cannot look blank.

**Each guest write reads its whole context in one statement** — the household, the deadline, the inviter, their plus-one with invitations, and the wedding's tier, which sets its guest cap — so naming costs that read and one batch (the guarded insert, the invitations, the change row and the read-back); renaming costs the read and one batch of three (clear any dietary answers, log the change, write the name and return it); removing costs the read and one batch of two (log the change, delete). Only a save's read carries the check for dietary answers on file.

**Each household write logs one change** for the organisers — `plus_one_added`, `plus_one_renamed` or `plus_one_removed` in the RSVP change log ([[cire-rsvp-changes]]), keyed on the guest who brought the plus-one, with no event. The row rides the batch that makes the change and is written only when that change happens: a double submit whose insert is skipped, a rename to the same name, and a plus-one already gone log nothing. The organiser's writes (the name correction, a permission switch that removes plus-ones) log nothing.

**Naming is one D1 batch, and it checks its rules inside the insert.** The guest row is an `INSERT … SELECT` from the inviter's row, which writes nothing unless, at that moment, the inviter is in the session's household, has permission, is not a plus-one, and the wedding has room for one more guest under the cap its tier gives it (`roomForOneMoreGuest` in `cire/api/src/services/tiers.ts`, which reads the tier as a scalar subquery in the same statement). D1 runs batches one at a time, so an organiser's revoke or another household's naming that commits first is seen by the one that commits second. When the insert writes nothing and the read-back finds no plus-one, a fresh read decides the answer: `403 plus_one_not_allowed` or `409 guest_capacity`. The insert is the only cap check a naming makes; no count runs ahead of it. The insert is also skipped by the one-per-guest index when a plus-one already exists (`ON CONFLICT DO NOTHING`, untargeted, since a conflict target cannot name a partial index; the row's id is a fresh UUID, so that index is the only thing it can meet), and the invitation copy reads the inviter's `guest_events` joined to the row that insert just wrote; the change row is written only if that row is there. So a double submit that raced past the read copies nothing and fails nothing; the read-back at the end of the batch returns whichever plus-one won.

### The reply

`POST /api/rsvp` stamps a plus-one's rows `consent_source = 'inviter_attested'`: the household typed them, and a plus-one never holds the household's code or sees the invite. So the household's tick for a plus-one's dietary requirements is not the plus-one's consent but the household's **attestation** that they agreed, in its own words and under its own version:

- The wording and version live together in `@cire/dietary` as `PLUS_ONE_DIETARY_ATTESTATION` (`cire/dietary/src/attestation.ts`), which both the invite and the API read. `cire/dietary/tests/attestation.test.ts` pins the two together.
- Each reply may carry `dietaryAttestation`: the version of the words the sheet showed. A plus-one's dietary data is stored only when it equals the constant the API stamps; anything else — no attestation, or words from another build of the invite — answers `422 plus_one_dietary_unavailable`. The guest site and the API deploy separately, so this is what keeps a copy change from being stamped with a version whose words were not on screen. The general consent gate (`dietaryConsent`) runs first.
- The reply also carries `dietaryAttestedName`: the full name the sheet showed the attestation for. A name the plus-one's row no longer carries answers `409 plus_one_changed`, and the sheet asks for a reload. A page opened before the household renamed its plus-one still holds the old person's answers, and without this a save from it would stamp a fresh attestation on the new person's row.
- The row is stamped with the attestation's version (`dietaryConsentVersionFor` in `cire/api/src/services/rsvp.ts`), never the guest's own-consent `DIETARY_CONSENT_VERSION`.
- A status-only reply needs no attestation.

**The organiser's recording route takes a plus-one's dietary data only under the organiser's plus-one attestation** (`ORGANISER_PLUS_ONE_DIETARY_ATTESTATION` in `@cire/dietary`), which speaks of the plus-one, and keeps the household's answer on a status-only save ([[#The RSVP table]]). The guest wording on a plus-one's reply gets `422 plus_one_dietary_unavailable`; a name the row no longer carries gets `409 plus_one_changed`, as on the invite. See the organiser-attested variant in [[dpia/cire-guest-data]].

**"Current" consent** — the boolean the invite seeds its boxes from (`dietaryConsentCurrent`) — means the record was made by the writer the box speaks for, against the words it shows now (`isDietaryConsentCurrent`): a member's row counts only as `guest` with `DIETARY_CONSENT_VERSION`, a plus-one's only as `inviter_attested` with the attestation's version. An organiser's recording never opens either box ticked. The claim payload and the RSVP read-back both answer through it.

The couple sees a plus-one's change the way they see any edited reply: in the RSVP table and the guest list. There is no separate notice.

---

## The portal

The organiser portal sets the permission on the **Households** tab (`GuestTable`), not in the guest editor. The permission routes write at once, while the editor stages every edit behind undo, discard and a preview, which an immediate switch would bypass; and a viewer co-host sees the Households tab but not the editor.

| Who | Sees |
|---|---|
| Owner or editor | A **Plus-one** column with a switch per guest, and per household "Plus-ones: N of M" with **Allow everyone** and **Allow no one** |
| Viewer | The same switches, read-only (focusable and announced as read-only, at full contrast); no household buttons |

- A plus-one's row sits straight after the guest who brought them (the organiser list arrives in `sort_order`, so the portal places them by the link), marked "Plus-one of <inviter's full name>", with no switch.
- The column is hidden when the API sends no `plusOneAllowed`: the portal can reach a tier before the API that serves the field.
- **One write at a time across the table.** While a permission write, or a reload that goes with it, is in flight, any other switch or household button pressed does nothing and stays as it was, so a reload never paints over a newer write and a household write never races one of its members'. Only the switches the write covers show it (read-only and busy), so a write re-renders those rows and not the whole roster.
- **Turning permission off over a named plus-one** opens a confirmation naming each plus-one it removes and whose they are, taken from the whole list rather than the rows a search shows. It opens on Cancel. On yes the portal sends `removePlusOnes` as the confirmation's own snapshot — each plus-one's id and stored first and last name, captured when it opened — never a list read again at that moment, which would echo whatever is current and defeat the API's check.
- A `409 plus_one_named` — to a plain turn-off over a plus-one named since the list loaded, or to a confirmation gone stale because the household named, swapped or renamed a plus-one meanwhile — reloads the list and opens the confirmation again, noting that the household changed its plus-ones.
- A confirmed plus-one the household has already taken back is not an error: the API removes the rest and reports how many it removed.
- The rows are reconciled into a store keyed by household code and guest id, so a write updates a row in place and focus stays on the switch that was pressed.

The switch is `@shared/ui`'s `Switch` ([[component-library]]).

---

## The RSVP table

The organiser portal's **RSVPs** tab (`RsvpView`) lists a plus-one like any guest, with three additions:

- **The marker.** Under the plus-one's name, on its own line, "Plus-one of <inviter's full name>" — the words the Households tab uses. It wraps rather than widening the fixed Guest column. When the API names no inviter (an older API, or none found) it reads "Plus-one of another guest".
- **The provenance badge.** A reply the household gave for its plus-one (`inviter_attested`) is badged **Household-entered**, in muted ink, apart from the gold **Host-entered** of an organiser's reply. A guest's own reply carries no badge.
- **Search.** The marker is part of what a word matches, so "plus-one" lists every plus-one and the inviter's name finds the guest they brought.

Recording a reply for a plus-one offers the same dietary picker and free text as for any guest, prefilled with the stored answer. Left as they are, the form says the stored requirements stay. Once the organiser edits them, an unticked box appears with the organiser's plus-one wording ("I confirm the plus-one consented…"), and the save carries that wording's version and the plus-one's full name.

The portal sends a save that leaves the dietary fields alone as `{ status }`. **A body with neither `dietary` nor `dietaryPresets` is status-only** for every guest, and the route then writes the status and nothing else (`rsvpService.recordStatus`, one upsert). For a plus-one:

| Stored reply | After an organiser's status-only save |
|---|---|
| The household's, with dietary answers or a consent record | Status changed; `dietary`, `dietary_presets`, `dietary_consent_at`, `dietary_consent_version` and `consent_source = 'inviter_attested'` kept |
| The household's, with neither | Status changed; `consent_source = 'organiser_attested'` |
| None | A new row, `organiser_attested`, no dietary data |

So the row keeps the household's attestation, and the household's box on the invite still opens ticked for it. On such a row `consent_source` names the dietary data's basis, not who wrote the status: the badge stays **Household-entered** (its tooltip says a host may have changed the status), and the CSV's **Recorded By** says **Household**. Nothing records that an organiser changed it; organiser writes are not in the change log ([[cire-rsvp-changes]]). The DPIA accepts that — see the inviter-attested variant in [[dpia/cire-guest-data]].

A body naming either dietary field is a dietary edit and replaces the whole reply, stamped `organiser_attested` with the organiser's plus-one version when it carries dietary data. An empty one clears the household's answer. The household's box on the invite then opens unticked over the organiser's answer, so a household re-submitting must tick its own attestation for it or clear it.

The host and the API deploy separately. A portal that sends `{ status }` for a guest, or the plus-one version, to an API without this behaviour gets the old upsert or a refusal, so the API goes to production first.

The table lists replies before the guests who have not answered, so a plus-one and their inviter sit together only when both have replied or neither has; the marker names the inviter either way.

---

## Reads

| Read | Carries |
|---|---|
| Claim payload `members[]` (`claim.ts`) | `plusOneAllowed`, `plusOneOf`; a plus-one is listed straight after the member who brought them, placed by the link rather than by `sort_order` |
| `GET …/guests` (`OrganiserGuestRow`) | `plusOneAllowed`, `plusOneOf` |
| `GET …/rsvps` (per-event view) | `plusOneOf` and `plusOneOfName` (the inviter's full name) on responded and unresponded entries; within each list a plus-one sits straight after their inviter. The name is joined from the inviter's own row, held to the plus-one's household, so a reply kept after the household was dropped from the event still names them and a link outside the household names no one |
| `GET …/rsvps.csv` | One row per guest, a plus-one's straight after their inviter's. **Plus-one Of** (the inviter's full name, blank otherwise) is the last column, after **Recorded By**, which says **Household** when any of the plus-one's replies is the household's (**Organiser** still outranks it) |
| `GET …/guests.csv` (the roster report, not the round-trip export) | A plus-one's row straight after their inviter's, with **Plus-one Of** appended after **Code Status** |

### Counting

A named plus-one is a guest row with invitations, so every read that counts guests counts them: the per-event tallies behind `GET …/rsvps` (`invited` once named, `attending` once they say so), the household guest counts, the events export's **Invited Guests**, the rows of both guest CSVs, and the guest cap. Permission alone creates no row and counts toward nothing. The per-event `attending` tally is the attending count a per-head figure reads.

`weddings.guest_count_estimate` is a number the organiser types in Settings; nothing derives it, so a plus-one does not move it.

---

## On the invite

The claim and welcome panel (`LoginSection`, [[cire-invite-designs]]) carries the household's plus-one prompt, `PlusOnePrompt`, in both design packs. It is its own lazy chunk, warmed with the account link and rendered only for a household with a permitted member or a named plus-one, never in host preview.

- **Naming.** Each permitted member gets a first and last name form (100 characters each, as the API allows). In a household each form is labelled "Ana's guest"; a guest on their own is spoken to directly.
- **A named plus-one** shows with "Change name" and "Remove". Removing asks first, naming the person, since their replies go too. A rename over dietary answers warns that it clears them, and says when it did. An "add" answered `created: false` (another device named someone first) says so, shows the name that stands, and says when that cleared dietary answers. Removing a guest the member may no longer bring removes their row; the prompt stays for that household and carries the confirmation, with focus on its heading.
- **The deadline.** Past the RSVP deadline the prompt shows named plus-ones without controls and offers nothing else, like the rest of the invite.
- **Art. 14.** The prompt asks the household to share the privacy notice with their guest, who never sees the invite; the notice (`cire/invites/src/pages/privacy.astro`) has a section for a person a guest brings — where their details came from, the basis for each, and how to correct, withdraw or delete them without a code.
- **State.** The prompt makes the request and hands the page an update (`onPlusOneChange`); the pack applies it to its claim result, so the Respond dialog, the greeting and every card read the one copy. The pure updates are in `cire/invites/src/components/plus-one-updates.ts`, which loads with the prompt; `plus-one.ts` holds only what every invite page asks (who is a plus-one, who was invited).
- **The Respond dialog** lists a plus-one after the member who brought them, labelled as their guest. Their dietary answers sit behind a second box — the attestation, naming only the plus-ones it covers — apart from the household's own consent box. Each box opens ticked only when every person it covers has a current record for that box.
- **The greeting** counts the members the couple invited: a guest on their own who names a plus-one is still greeted by name.
- **Completeness.** `hasHouseholdResponded` (the Respond button's tick) and the sheet's celebration leave plus-ones out, so naming a guest after answering never takes a tick back. The prompt says plainly while a named guest still has an event unanswered.
- **Account linking** does not take a plus-one's seat: the invite does not offer it ("Which guest are you?" is asked of people holding the code), and `POST /api/account/link` refuses it (`403 plus_one_seat`). A plus-one seat already linked stays listed so its Unlink is reachable.

---

## The change pipeline

A plus-one is the household's data, not the organiser's sheet. The reconcile pipeline ([[cire-guest-event-editor]]) — spreadsheet upload, editor save, revert — never matches, edits or removes one on its own account:

- **The round-trip export** (`state-export.ts`, every fidelity including the checkpoint snapshot) leaves plus-ones out, so export → re-import → diff still changes nothing.
- **The diff** (`import.ts diffAgainstDb`) matches only the organiser's guests. A desired row that names a plus-one's id is dropped before matching. The organiser editor leaves plus-ones out of its drafts anyway (`cire/host/src/lib/guest-event-draft.ts`): a draft carrying the id of a plus-one removed since would otherwise be refused as stale, with no concurrent edit to explain it.
- **A removed guest takes their plus-one**, named in the plan's removals, its RSVP-loss warnings and a warning of its own ("Removing guest Bo also removes their plus-one Sam.").
- **A plus-one's invitations follow the inviter's.** Their desired events are the inviter's desired events, so the plan adds and drops their links with the inviter's.
- **Plus-ones hold places under the guest cap** in the preview's arithmetic, as they do at apply time.
- **An events revert** that re-creates an event re-invites each live plus-one wherever it re-invites their inviter.

### Not carried

- A revert, or a spreadsheet first-name change without an id (a remove + create), re-creates a guest **without** their permission and without the plus-one that went with them.
- Plus-ones named after a checkpoint **survive** a revert to it.

---

## Rollback

Migration 0066 only adds. Dropping the columns means rebuilding `guests`, and under D1's always-on foreign keys dropping `guests` cascades into `rsvps`, `guest_events` and `guest_account_links` — so in practice it is not undone. A Worker rolled back past this change, once plus-ones exist, treats them as ordinary guests: they re-enter the editor draft and the round-trip export.

---

## Observability

| Metric | Attributes |
|---|---|
| `cire.plus_one.changed` | `action`: `added` \| `renamed` \| `removed`; `actor`: `guest` \| `organiser` |
| `cire.plus_one.blocked` | `reason`: `preview` \| `deadline` \| `not_allowed` \| `capacity` |
| `cire.plus_one.permission.set` | `scope`: `guest` \| `household`; `allowed`: `on` \| `off` |
| `cire.rsvp.blocked` | gains `reason = plus_one_dietary`: a plus-one's dietary data without the current attestation |

`cire.rsvp.upserted` counts a plus-one's reply as a `guest` write, and an organiser's status-only one as `organiser`. Spans: `cire.rsvp.recordStatus` (that status-only write), `cire.plus_one.save`, `.remove`, `.renameAsOrganiser`, `.setGuestPermission`, `.setHouseholdPermission`. No log line carries a name.

---

## Files

| Concern | File |
|---|---|
| Columns | `cire/db/src/schema.ts` (`guests`, `rsvps.consent_source`), `cire/db/migrations/0066_plus_ones.sql`, `cire/api/src/db/setup.ts` |
| Service | `cire/api/src/services/plus-one.ts` |
| Routes | `cire/api/src/routes/plus-one.ts`, `cire/api/src/routes/organiser-plus-one.ts` |
| Bodies | `cire/api/src/schemas/plus-one.ts` |
| Reply provenance | `cire/api/src/routes/rsvp.ts`, `cire/api/src/services/rsvp.ts` |
| Organiser recording | `cire/api/src/routes/organiser-rsvp.ts`, `cire/api/src/services/organiser-rsvp.ts` |
| Reads | `cire/api/src/services/claim.ts`, `cire/api/src/services/rsvp-export.ts`, `cire/api/src/services/table-export.ts` |
| Pipeline | `cire/api/src/services/import.ts`, `state-export.ts`, `revert.ts` |
| Editor draft | `cire/host/src/lib/guest-event-draft.ts` |
| Portal controls | `cire/host/src/components/GuestTable.tsx`, `cire/host/src/lib/plus-one-permission.ts` |
| RSVP table | `cire/host/src/components/RsvpView.tsx`, `cire/host/src/lib/rsvp-filter.ts` |
| Attestation wording and version | `cire/dietary/src/attestation.ts` |
| Consent version and "current" | `cire/api/src/services/rsvp.ts` (`dietaryConsentVersionFor`, `isDietaryConsentCurrent`) |
| Guest capture | `cire/invites/src/components/PlusOnePrompt.tsx`, `plus-one.ts`, `plus-one-updates.ts`, `LoginSection.tsx`, `RsvpModal.tsx`, `designs/{classic,gala}/InvitePage.tsx` |
| Privacy notice | `cire/invites/src/pages/privacy.astro` |
