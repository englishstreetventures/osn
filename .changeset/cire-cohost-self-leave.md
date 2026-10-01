---
"@cire/api": patch
"@cire/host": patch
---

Let a co-host leave a wedding.

`DELETE /api/organiser/weddings/:weddingId/hosts/me`, behind `weddingMember()`,
deletes the caller's own `wedding_hosts` and `host_rsvp_notices` rows in one
batch. The owner has no seat and gets 409 `owner_cannot_leave`. The
`cire.host.removed` counter gains an `actor` attribute (`owner` or `self`) and an
`owner_refused` result.

The organiser portal's co-host panel offers editors and viewers a "Leave this
wedding" control with a confirm step. On success the wedding leaves the list,
which returns to the list and drops the wedding's cached rows.
