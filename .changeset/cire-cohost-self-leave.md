---
"@cire/api": patch
"@cire/host": patch
---

Let a co-host leave a wedding.

`DELETE /api/organiser/weddings/:weddingId/hosts/me`, behind a new
`weddingSeat()` gate that admits any seat holder (helpers included), deletes the caller's own `wedding_hosts` and `host_rsvp_notices` rows in one
batch. The owner has no seat and gets 409 `owner_cannot_leave`. The
`cire.host.removed` counter gains an `actor` attribute (`owner` or `self`) and an
`owner_refused` result.

The organiser portal offers a "Leave this wedding" control with a confirm step:
on the co-host panel for editors and viewers, and on the run-sheet screen for
helpers. On success the wedding leaves the list,
which returns to the list and drops the wedding's cached rows.
