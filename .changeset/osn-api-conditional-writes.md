---
"@osn/api": patch
---

Writes that follow a read now hold only while what was read still holds.

- Email change complete counts the changes in the last 7 days again inside each statement of its commit: the address changes and the audit row goes in only while fewer than two are on record, and the other sessions end only once that row is in. Of two changes that each passed the preflight with one on record, one commits and the other is refused with `Email change limit reached (2 per 7 days)`.
- Accepting, declining or cancelling a connection request and removing a connection change the connection only while it is as read; one accepted, declined or removed in between is left, and the request is refused with `Pending request not found` or `Connection not found`. A connection request is written only while neither profile blocks the other and no connection stands between them, either way round; otherwise `Cannot send connection request` or `Connection already exists`, where two requests at once answered a database error. A block is inserted before the connections between the two are deleted. Of two unblocks at once, the second answers `Block not found`.
- Adding a member, removing one, changing a role and updating an organisation write only while the caller's admin row and the member's row (and, for an admin removing a member, its plain-member role) are as checked. A caller demoted, or a member promoted or removed, in between changes nothing, and the request is refused with the message the checks give: `Only admins can add members`, `Only admins can remove members`, `Only the owner can remove an admin`, `Only admins can update the organisation`, `Member not found`, `Organisation not found` or `Profile is already a member`, where two adds of one profile at once answered a database error.
- A refresh token's lazy delete of its expired session deletes it only while it is still expired, so a session another verify of the same token has just extended stays.
