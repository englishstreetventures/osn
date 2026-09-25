---
"@cire/api": patch
"@cire/host": patch
---

Page the gift log on its own route, and lay the RSVP tables out fixed.

"Load more gifts" now calls `GET /api/organiser/weddings/:weddingId/registry/gifts?offset=`,
which answers `{ gifts, giftsHasMore }` from the gift log's own two reads, run
together. It used to call the whole registry snapshot again with
`?giftsOffset=`, re-reading settings, items, claim counts, currency and totals
for every page and then discarding them. `GET /registry` now always carries
page one and takes no offset. The offset must be plain digits or it reads as
page one, so `1e9` no longer means offset 1. Past the offset cap the log answers
an empty page, and the page whose successor would pass the cap reports no more,
so the portal stops instead of appending the last page again on every click.

The organiser RSVP tables use `table-layout: fixed` with set column widths
(Guest 12rem, Household 9rem, Status 9rem, Actions 8rem, Dietary the rest), so a
search keystroke no longer makes the browser measure every remaining cell to
size the columns. The columns hold still while the list narrows, the text cells
break a word too long for their column, and a phone scrolls the table sideways
from a 45rem floor (37rem for a viewer, who has no actions column).
