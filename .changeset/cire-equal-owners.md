---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

A wedding can have more than one owner, and every owner is equal.

Ownership moves from `weddings.owner_osn_profile_id` to `wedding_hosts`
seats with the role `owner`; migration `0076_wedding_owners` seats every
current owner and drops the column. Any owner holds every owner power —
claim codes, settings, billing, the registry's payout account, the CSV
exports, and who helps, the wedding's creator included. A wedding keeps at
least one owner (409 `last_owner`), and an owner may leave through
`DELETE /hosts/me` only while another owner remains. `GET /hosts` lists
owners as seats and no longer returns a separate `owner` field. The RSVP
digest and the retention gift summary go to every owner.

Host management is owner-only: `POST /hosts` moves from `weddingEditor()` to
`weddingOwner()`, so an editor gets 403 `forbidden` at every role, and an
owner may seat anyone at any role, `owner` included. Owners count towards
the 50-seat cap (409 `host_cap_reached`). The module CSV exports
(`rsvps.csv`, `guests.csv`, `events.csv`, `gifts.csv`, `export/events.csv`,
`export/guests.csv`) move from `weddingMember()` to `weddingOwner()`, and
`mark-shared` moves from `weddingOwner()` to `weddingEditor()`.

The organiser portal lists owners in the co-host panel, lets an owner make
another owner (after a confirmation) or step down from their own seat, shows
the add form and the CSV download buttons to owners only, marks a household
sent when an editor copies its message, and explains each refusal.
