---
"@cire/api": patch
"@cire/host": patch
---

Co-hosts are added as viewers and their role is set from a dropdown on their
row, which also carries `helper` — the run-sheet-only seat the API has had
since the role gates landed and nothing could assign.

The portal's role checks are now one exhaustive decision in
`cire/host/src/lib/wedding-roles.ts` rather than four comparisons spread
across the components. The one it replaces was `role !== "viewer"` meaning
"may edit", which handed every write surface to any role it had not been
written against — a helper, and anything the API might send next.

Promoting a seat to `editor` asks first; a demotion does not. A helper opens
onto what their seat covers instead of a dashboard whose every panel would
answer 403, and is offered neither the invite preview nor the palette's
module rows.

On the API, which stored values a route may write is now a map with one
answer per value the column holds, so a role added to `wedding_hosts.role`
cannot become assignable by silence. A roleless add lands on `viewer`
instead of `editor`.
