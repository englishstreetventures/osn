---
"@cire/api": patch
---

Read the gift export in one capped query, and take every export's filename
from the member gate's own read.

- **The gift export is one query.** Claims and cash gifts come back from a
  single `UNION ALL`, ordered newest first and limited in SQLite to the
  2,000-row ceiling plus one. Each table no longer reads up to the ceiling on
  its own for the Worker to merge, sort and cut.
- **The truncation warning no longer logs a row count.** The read stops one row
  past the ceiling, so the count was always that. The warning now carries
  `truncated: true` and the ceiling.
- **The slug comes from the gate.** `hostsService.authorize()` reads the
  wedding's slug with its owner, and `weddingMember()` exposes it as
  `weddingSlug`. The six organiser CSV exports (for the filename), `GET
  /events` (for event-image paths) and `POST /preview-code` (for the preview
  link) use it instead of reading the wedding row again.
  `weddingsService.slugOf` is gone; `claimService.listEvents` and
  `hostCodeService.ensureForWedding` now take the slug as an argument.
- **The ceiling comment says what binds.** Streaming the response would spend
  the same CPU, so it would not raise the ceiling; the comment no longer says
  it would.
- **New tests** hold the export to the portal's gift log column by column, pin
  which rows survive the ceiling, count the statements the export and the
  export routes issue, and run the union on real D1.
