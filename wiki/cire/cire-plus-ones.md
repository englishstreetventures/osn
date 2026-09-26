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
last-reviewed: 2026-09-27
---
# Plus-ones

A guest may bring a plus-one when an editor co-host allows it. The household names the plus-one on the invite, and from then on the plus-one is a guest like any other: they appear in the Respond dialog, reply to their events, and count in every tally.

This page is the contract. The host permission UI, the guest capture on the invite and the host RSVP display build on it.

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
- is **one per guest, per wedding** — the unique index on `plus_one_of_guest_id` enforces it, and doubles as the probe the cascade runs on every guest delete;
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
| `PUT /api/organiser/weddings/:weddingId/guests/:guestId/plus-one` | `{ allowed, removePlusOne? }` | `{ guestId, plusOneAllowed, plusOneRemoved }` |
| `PUT /api/organiser/weddings/:weddingId/families/:familyId/plus-one` | `{ allowed, removePlusOnes? }` | `{ familyId, plusOneAllowed, guestsUpdated, plusOnesRemoved }` |
| `PUT /api/organiser/weddings/:weddingId/guests/:guestId/plus-one/name` | `{ firstName, lastName? }` | `{ plusOne }` |

- The household route writes every member's flag and skips the household's plus-ones.
- **Turning permission off where a plus-one is already named is refused** — `409 { error: "plus_one_named", named }` — unless the remove flag is set. With it, the plus-one and their replies go in the same batch as the switch. Deleting a guest's data is never a side effect of `allowed: false`, because this delete sits outside the change history: there is no preview and no revert. The portal must name the plus-one and ask before it sends the flag.
- `404 guest_not_found` / `family_not_found` for a row outside the wedding or in the host-preview household; `409 plus_one_cannot_invite` on a plus-one's own row.
- The name route corrects the name of the plus-one `:guestId` brought (`404 plus_one_not_found` if none). It is the one organiser write to a plus-one's own row, there so a name can be put right after the deadline has locked the household out (Art. 16).

### The household owns the plus-one

Behind the household session cookie, like `POST /api/rsvp`, with no Turnstile for the same reason: the cookie came from a Turnstile-gated claim. A per-IP limiter (20 a minute, as on the guest registry writes) caps the write rate: naming and removing in a loop would otherwise spend the D1 write quota every wedding shares. `:guestId` is the member bringing the plus-one.

| Route | Body | Answer |
|---|---|---|
| `PUT /api/plus-one/:guestId` | `{ firstName, lastName? }` | `{ plusOne: { guestId, firstName, lastName, plusOneOf, eventIds }, created }` |
| `DELETE /api/plus-one/:guestId` | — | `{ removed }` (idempotent) |

`PUT` names the plus-one, or renames the one already named. Refusals, in the order they are checked:

| Status | `error` | When |
|---|---|---|
| 403 | `Unauthorized` | The session's household row is gone |
| 403 | `Preview sessions cannot change plus-ones` | The organiser's host preview |
| 403 | `rsvp_closed` | The RSVP deadline has passed — same predicate and instant as the RSVP write ([[cire-rsvp-deadline]]) |
| 404 | `guest_not_found` | `:guestId` is not in this household |
| 409 | `plus_one_cannot_invite` | `:guestId` is itself a plus-one |
| 403 | `plus_one_not_allowed` | No permission (`PUT` only — taking a plus-one back needs none) |
| 409 | `guest_capacity` | Naming one would pass the wedding's guest cap ([[cire-entitlements]]) |
| 429 | — | The per-IP limiter's budget is spent |

Names are trimmed and at most 100 characters each. They may not contain control, format or separator characters (Unicode `Cc`, `Cf`, `Zl`, `Zp` — zero-width spaces, direction marks and overrides among them — save the zero-width joiner and non-joiner some scripts need) or the letters that render blank. A first name must contain a letter or digit, so it cannot look blank.

**Naming is one D1 batch.** The guest insert is skipped by the one-per-guest index when a plus-one already exists (`ON CONFLICT DO NOTHING`), and the invitation copy reads the inviter's `guest_events` joined to the row that insert just wrote. So a double submit that raced past the read copies nothing and fails nothing; the read-back at the end of the batch returns whichever plus-one won.

### The reply

`POST /api/rsvp` stamps a plus-one's rows `consent_source = 'inviter_attested'`: the household typed them, and a plus-one never holds the household's code or sees the invite. **Both write paths refuse dietary data on a plus-one's reply** (`422 plus_one_dietary_unavailable`) — the invite's, and the organiser's recording route, whose rows the household reads back — until the invite shows wording for the household's attestation and a consent version to go with it — see the inviter-attested variant in [[dpia/cire-guest-data]]. A status-only reply is accepted.

The couple sees a plus-one's change the way they see any edited reply: in the RSVP table and the guest list. There is no separate notice.

---

## Reads

| Read | Carries |
|---|---|
| Claim payload `members[]` (`claim.ts`) | `plusOneAllowed`, `plusOneOf`; a plus-one is listed straight after the member who brought them, placed by the link rather than by `sort_order` |
| `GET …/guests` (`OrganiserGuestRow`) | `plusOneAllowed`, `plusOneOf` |
| `GET …/rsvps` (per-event view) | `plusOneOf` on responded and unresponded entries |

### Counting

A named plus-one is a guest row with invitations, so every read that counts guests counts them: the per-event tallies behind `GET …/rsvps` (`invited` once named, `attending` once they say so), the household guest counts, and the guest cap. Permission alone creates no row and counts toward nothing.

`weddings.guest_count_estimate` is a number the organiser types in Settings; nothing derives it, so a plus-one does not move it.

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
- The guest-cap check and the permission check before naming are reads followed by an insert, and an organiser's revoke reads "no plus-one named" before its update. Concurrent requests can overshoot the cap by the number in flight, or leave a plus-one named under a permission revoked at the same moment. Tracked as a follow-up to check both inside the write.

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
| `cire.rsvp.blocked` | gains `reason = plus_one_dietary` |

`cire.rsvp.upserted` counts a plus-one's reply as a `guest` write. Spans: `cire.plus_one.save`, `.remove`, `.renameAsOrganiser`, `.setGuestPermission`, `.setHouseholdPermission`. No log line carries a name.

---

## Files

| Concern | File |
|---|---|
| Columns | `cire/db/src/schema.ts` (`guests`, `rsvps.consent_source`), `cire/db/migrations/0066_plus_ones.sql`, `cire/api/src/db/setup.ts` |
| Service | `cire/api/src/services/plus-one.ts` |
| Routes | `cire/api/src/routes/plus-one.ts`, `cire/api/src/routes/organiser-plus-one.ts` |
| Bodies | `cire/api/src/schemas/plus-one.ts` |
| Reply provenance | `cire/api/src/routes/rsvp.ts`, `cire/api/src/services/rsvp.ts` |
| Reads | `cire/api/src/services/claim.ts`, `cire/api/src/services/rsvp-export.ts` |
| Pipeline | `cire/api/src/services/import.ts`, `state-export.ts`, `revert.ts` |
| Editor draft | `cire/host/src/lib/guest-event-draft.ts` |
