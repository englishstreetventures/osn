---
"@cire/api": patch
"@cire/host": patch
---

A revert puts back what was stored, editor rows keep their provenance, and a
stale editor draft can be reloaded with its edits kept.

- `@cire/api`: a checkpoint before-image is written without the spreadsheet
  formula guard, with Start/End as stored and with `Family Source` /
  `Guest Source` columns, and the revert reads it with snapshot readers that
  skip the upload caps and checks. Households and guests the editor creates are
  stored `source = 'manual'`; a before-image restore manages manual rows. Apply's
  head-moved 409s carry `reason: "head_moved"`.
- `@cire/host`: both editors offer "Reload and keep my edits" when a save is
  refused because someone else's change landed, replaying the unsaved edits on
  the fresh rows and listing any that could not be kept.
