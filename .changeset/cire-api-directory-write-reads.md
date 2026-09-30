---
"@cire/api": patch
---

Stop reading back rows the vendor directory has just written.

- `directoryService.consumeClaim` takes the bound listing from the bind's
  `RETURNING` row, read beside the categories, instead of selecting it again. A
  claim costs 4 statements, not 5. The token is still burned before the bind
  starts, and a claim whose listing has gone now fails as an invalid claim
  instead of a 500.
- `directoryService.upsertListingForOrg` takes an updated listing from the
  UPDATE's `RETURNING` row and answers with the categories it wrote, sorted,
  instead of reading both back.
- `directoryService.getLiveListingById` now takes the wedding id and reports
  `inWedding` from the same statement, so adding a listing from the directory
  no longer runs a separate duplicate check. `vendorsService.existsForDirectory`
  is removed.
- `vendorsService.create` reads only the top `sort_order` of the vendor's
  status group, not every row in it.
