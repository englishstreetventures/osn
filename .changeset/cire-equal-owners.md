---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
---

A wedding can have more than one owner, and every owner is equal.

Ownership moves from `weddings.owner_osn_profile_id` to `wedding_hosts`
seats with the role `owner`; migration `0071_wedding_owners` seats every
current owner and drops the column. Any owner holds every owner power —
claim codes, settings, billing, the registry's payout account, and who
helps, the wedding's creator included. Only an owner can make someone an
owner (`POST /hosts` or `PUT /hosts/:id/role` with `owner`; an editor gets
403 `owner_role_forbidden`). A wedding keeps at least one owner (409
`last_owner`) and holds at most four (409 `owner_cap_reached`); owners do not
count towards the 50 co-host cap. `GET /hosts` lists owners as seats and no
longer returns a separate `owner` field. The RSVP digest and the retention
gift summary go to every owner.

The organiser portal lists owners in the co-host panel, lets an owner make
another owner (after a confirmation) or step down from their own seat, and
explains each refusal.
