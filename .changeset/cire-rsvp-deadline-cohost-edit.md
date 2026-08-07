---
"@cire/api": patch
"@cire/db": patch
"@cire/host": patch
---

Let an `editor` co-host set the wedding's RSVP-by date.

The deadline lives in Settings, which is owner-only — but it is the one field
on that panel that *runs* the wedding rather than describing it. The co-host
chasing replies is exactly the person who needs to move the date.

`PUT /api/organiser/weddings/:weddingId/settings` moves from `weddingOwner()`
to `weddingEditor()` plus a field-level owner check, because a middleware can't
say "this field, not that one": the gate decides who reaches the handler (a
`viewer` still gets 403 `read_only_role`), and the handler rejects a non-owner
patch that touches anything beyond `rsvpDeadline`/`rsvpDeadlineTimezone` with
403 `owner_only_fields`, naming the keys. Shape is decoded first, so a co-host
who typos a date is told the date is wrong rather than that they lack
permission for a field they may write. The refusal is whole — a patch mixing
the deadline with an owner-only field writes neither — and it is a refusal
rather than a silent filter, since a save that reports success while discarding
half the form is the worse failure.

The allow-list is derived from the request schema's own field list and reads
each key the way the writer does, so the gate and the write path cannot
disagree about what a patch contains, and a setting added later is owner-only
from the moment it exists. Both deadline keys travel together: admitting the
date without its zone would leave a co-host able to set a deadline they can't
say the zone of, and the zone is what makes "the end of that day" mean
anything.

Two consequences of the profile no longer having a single writer:

- The settings UPDATE now names only the columns the patch carries. The old
  full-row read-modify-write meant a co-host's deadline save rewrote
  `displayName` and `currency` from a value read moments earlier, able to
  revert an owner's concurrent edit to a field the gate exists to protect.
- Migration `0056` adds `weddings.updated_by_osn_profile_id`, so a change to a
  guest-facing lock has an author. An owner who finds RSVPs closed can now
  establish whether they did it themselves. NULL on existing rows reads as
  "unknown", never as "the owner".

An RSVP-by date can no longer be set in the **past** by anyone, owner included:
a backdated deadline locks the invite for every guest the instant it lands, and
a guest turned away is told only that RSVPs closed, never that the date moved
under them (400 `rsvp_deadline_in_past`). Today stays available — the deadline
closes at the *end* of its day — as does leaving a naturally lapsed deadline
alone, or clearing it to reopen replies. The check runs on the resulting
date+zone pair through the same `isRsvpClosed` the guest write gate uses, so
the two can't disagree about when a day ends.

In the portal, a co-host sees the profile fields still disabled with the
RSVP-by picker live, under a button labelled "Save RSVP-by date" — "Save
settings" beside five disabled fields reads as a button about to overwrite
them. That save sends the deadline pair alone, not the untouched values sitting
in the disabled inputs, which would earn the 403. A refused save now blames the
permission instead of telling the organiser to check fields that are fine.
