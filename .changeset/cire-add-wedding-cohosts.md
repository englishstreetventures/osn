---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
---

Co-hosts for cire weddings: an organiser (the owner) can add another person as a
host of a specific wedding by their OSN handle, see the host list, and remove a
host. A co-host gets access to that wedding's organiser dashboard.

- `@cire/db`: new `wedding_hosts` join table (`wedding_id` FK→weddings CASCADE,
  `osn_profile_id`, `added_by_osn_profile_id`, `role`, `created_at`; unique on
  `(wedding_id, osn_profile_id)`) + forward-only D1 migration `0013_wedding_hosts.sql`.
  The wedding owner stays the single `weddings.owner_osn_profile_id`; co-hosts
  are additive and never rowed in as the owner.
- `@cire/api`: `POST/GET/DELETE /api/organiser/weddings/:weddingId/hosts[/:osnProfileId]`.
  Add + remove are owner-only (`weddingOwner`); the new `weddingMember` gate
  (owner OR co-host) admits co-hosts to the dashboard reads (`/guests`, `/events`,
  host listing) while destructive actions stay owner-only. The owner-typed handle
  is resolved to a profile id server-to-server over ARC (`graph:read`) via a new
  `resolveHandle` bridge; when the ARC key is absent the add-host POST fails closed
  with 503. `GET /api/organiser/weddings` now lists owned AND co-hosted weddings,
  each tagged `role: owner | host`.
- `@cire/organiser`: a "Hosts" tab on each wedding's dashboard — add by handle,
  list, remove (owner only); co-hosts see the dashboard read-only with a Co-host
  badge, and owner-only surfaces (spreadsheet import) are hidden for them.
