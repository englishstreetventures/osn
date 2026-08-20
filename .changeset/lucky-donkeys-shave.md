---
"@osn/api": patch
---

Narrow the `listMembers` service projection to `{ id, handle, displayName }`.

The service selected and returned `avatarUrl`, `createdAt` and `updatedAt` as
well, and its only caller — the `GET /organisations/:id/members` route — never
used them: the route already gates on membership and already projects the wire
response down to `handle` and `displayName`. So nothing leaked; this is
defence in depth. Handing back four unused fields meant a future route that
spread the profile object instead of projecting it would widen the response
without anyone noticing. `id` stays, because clients need it to call
`removeMember` and `updateMemberRole`. The wire contract does not change.
