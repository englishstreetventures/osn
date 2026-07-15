---
"@cire/api": minor
"@cire/db": minor
"@cire/organiser": minor
---

Co-host roles for cire weddings (platform Phase 0 PR 2): a co-host seat is now
an `editor` (full module writes — a partner or hired planner) or a `viewer`
(read-only), enforced by a new `weddingEditor()` authz gate that sits between
`weddingMember()` and `weddingOwner()`.

- `@cire/db`: `wedding_hosts.role` enum widened to `editor`/`viewer` (the
  legacy `host` value stays in the type only because the column's DDL DEFAULT
  can't change without a rebuild). Data-only D1 migration
  `0031_wedding_host_roles.sql` rewrites every existing `'host'` row to
  `'editor'`; readers normalise any stray `'host'` to `editor`.
- `@cire/api`: new `weddingEditor()` middleware (viewers get 403
  `read_only_role`, a distinct error string). Routes re-gated to the roles
  matrix (platform-plan §3.5): spreadsheet import, invite-builder writes
  (text/theme/images/crops), and event-location + geocode move to the editor
  gate; family `deactivate`/`reactivate` move up to owner-only (claim codes
  are the guest credential); `preview-code` moves down to `weddingMember()` so
  every co-host — including viewers — can preview the invite (previously
  owner-only, a gap since the Preview button renders for all members).
  `POST /hosts` accepts `role` (default `editor`, so older portal builds keep
  working); new owner-gated `PUT /hosts/:osnProfileId/role` flips a seat
  between editor and viewer (404 `host_not_found` for non-seats, incl. the
  owner) with a new `cire.host.role_changed` counter. `GET /api/organiser/weddings`
  tags each row `role: owner | editor | viewer`.
- `@cire/organiser`: the wedding header badge shows Owner/Editor/Viewer;
  viewers get a read-only dashboard (import panel hidden, invite tab shows a
  view-only notice pointing at Preview invite, event-location editor hidden,
  household deactivate/reactivate now owner-only in the guest table). The
  Hosts tab gains an Editor/Viewer access picker on add, a role badge per
  host, and an owner-only "Make editor"/"Make viewer" control.
