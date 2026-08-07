---
"@cire/api": patch
"@cire/organiser": patch
---

Fix: a wedding's owner never appeared in the organiser portal's co-hosts list —
the owner is intentionally never a row in `wedding_hosts` (see `services/hosts.ts`),
so the co-host panel had no way to say who owned the wedding at all, not even to
the owner themselves.

- `@cire/api`: `GET /api/organiser/weddings/:weddingId/hosts` now also returns an
  `owner: { osnProfileId, handle?, displayName? }` field, resolved the same
  fail-soft way as co-host handles. `weddingMember()` derives
  `weddingOwnerOsnProfileId` for every admitted caller (owner or co-host), not
  just the write gates.
- `@cire/organiser`: `HostsPanel` renders the owner in its own row above the
  co-host list — an "Owner" badge, no role-change or remove control (those
  actions don't apply to an owner).
