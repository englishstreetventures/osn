---
"@pulse/db": patch
"@pulse/api": patch
"@pulse/app": patch
"@osn/api": patch
"@osn/db": patch
"@osn/client": patch
"@osn/social": patch
"@shared/observability": patch
---

Migrate close friends from OSN core to Pulse.

Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
app can implement its own close-friends-style list against the OSN connection
graph; OSN core retains only `connections` and `blocks`.

What it does in Pulse:

- **Feed boost.** Events organised by a close friend surface higher in
  `listEvents` (stable partition: chronological order preserved within each
  bucket; not applied for anonymous viewers).
- **Hosting affordance.** The existing RSVP avatar ring — driven by an
  attendee having marked the viewer as a close friend — is preserved end-to-end,
  now backed by the local `pulse_close_friends` table.
- **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
  header avatar dropdown).

Surface changes:

- New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
  routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
  `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
- Removed: OSN-core `close_friends` table, services, routes (user-facing
  `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
  graph close-friend SDK methods on `@osn/client`, the close-friends tab in
  `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
  and the `GraphCloseFriendAction` observability attribute.
- Connection projection now includes `id` so cross-DB references (Pulse adding
  by profile id) work without duplicating handle→id resolution.

Pre-launch: the OSN `close_friends` table is dropped outright; seed data
updated. No migration path or backwards-compatibility shims.
