---
"@cire/api": patch
---

Fold two pairs of D1 reads into one.

`directoryService.getLiveListingById` now reads the listing and its
categories in one statement, a LEFT JOIN, instead of two queries run side by
side. An id that is missing or not live costs one statement rather than two,
and a hit costs one as well.

The guest-data retention sweep now selects each wedding's final-event date in
the query that picks the cohort, and hands it to the gift summary step, which
no longer groups the `events` table a second time to find it. The sweep reads
`events` once.
