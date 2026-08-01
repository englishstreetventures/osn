---
"@cire/api": patch
"@cire/organiser": patch
---

Let an `editor` co-host add more co-hosts.

`POST /api/organiser/weddings/:weddingId/hosts` moves from `weddingOwner()` to
`weddingEditor()`. `DELETE /hosts/:osnProfileId` and `PUT /hosts/:osnProfileId/role`
stay owner-only.

The split is additive-versus-subtractive rather than read-versus-write, and that
is what keeps it from being a privilege ladder. `editor` is the ceiling of what
anyone can grant — `role` is `editor | viewer` and the owner is never rowed into
`wedding_hosts` — so an editor adds a peer, never a superior. And because
demotion and removal stay with the owner, an editor cannot evict the owner's
other co-hosts, cannot demote a rival, and cannot entrench themselves: every
seat they create is reversible by the one person who cannot be removed.

The gate swap alone would have shipped a bug. The handler passed the caller's
own `osnProfileId` as both `addedByOsnProfileId` and `ownerOsnProfileId`, which
was harmless only because `weddingOwner()` made them the same person. With an
editor calling, the `owner_is_host` check would have compared the owner's id
against the editor's, missed, and rowed the owner in as a co-host of their own
wedding. `weddingEditor()` now derives `weddingOwnerOsnProfileId` from the query
it already runs, and the two ids are passed separately — so `added_by` credits
the actual adder.

In the portal, `HostsPanel` splits `canManage` into `canManage` (owner: role
flip and remove) and `canAdd` (owner or editor: the add form), so the UI never
offers a button the API would refuse.
