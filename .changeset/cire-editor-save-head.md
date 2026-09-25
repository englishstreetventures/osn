---
"@cire/api": patch
"@cire/host": patch
---

Check every in-app guest and schedule save against the state the editor loaded.

- The change head is a digest over every committed change. It now moves on each apply and each revert, whatever order they commit in. Before, it was the id of the newest change, which a revert of that same change left in place.
- New `GET /api/organiser/weddings/:weddingId/changes/head`. Each editor reads it before loading its rows, then reloads those rows fresh.
- The editor draft body must now carry `baseRevision` and `removeManual: true`. Preview answers 409 `stale_draft` when the head has moved since the load. This stops a household that a co-host saved in the meantime from being planned away as a removal.
- `/events` is now `no-store`, like `/guests` and `/households`.
- The guests editor saves with `scope: "guests"`. On that scope, a stale event or an attendance name that no longer resolves is refused, instead of dropping the invitation.
- An editor save that empties every event or every household must echo the preview's `clears` counts back as `confirmClears`. The preview names that loss in its own warning.
- If the reload after a successful save fails, the editor drops its draft instead of leaving it saveable.
- Revert refuses a change that is not `applied` (409).

Deploy `@cire/api` to production before `@cire/host`.
