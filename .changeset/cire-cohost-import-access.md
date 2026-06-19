---
---

Cire wedding co-hosts can now use the spreadsheet/CSV import and the invite
builder, not just the read-only dashboard.

The import routes (`/api/organiser/weddings/:weddingId/import/{preview,apply,revert,list}`)
and the invite-builder read + customisation routes (`GET /invite`, `PUT /invite/text`,
`PUT /invite/theme`, `POST|DELETE /invite/image/:slot`) moved from the owner-only
`weddingOwner()` gate to `weddingMember()` (owner OR co-host). Co-hosts are trusted
co-organisers, so they get **full** import access — they can both preview and apply
imports — and can view + customise the invite, exactly like the owner.

Owner-only stays narrowly scoped to *managing the wedding itself*: re-minting /
regenerating claim codes, mark-shared, preview-code provisioning, adding/removing
co-hosts (`POST/DELETE /hosts`), and deleting the wedding. `weddingMember()`
resolves authorization via `hostsService.authorize()` and **fails closed** if the
host/ARC lookup is unavailable.

UI (`@cire/organiser`): `OrganiserApp.tsx` no longer hides the `<ImportPanel>`
from co-hosts; the Invite tab was already member-visible. Only the owner-only
Codes (re-mint) and Hosts management actions remain gated on `canManage`.
