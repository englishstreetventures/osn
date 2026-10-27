---
"@cire/api": patch
"@cire/host": patch
---

A change preview now expires. `POST …/changes/apply` answers 409 `{ reason: "preview_expired" }` for a preview at least `PREVIEW_EXPIRES_AFTER_MS` old — the `cire-sheets` reconciler's 7-day grace window less an hour — before it reads or stores anything in R2, so a retried apply stores a change's before-image again only while the first store is inside that window. A preview both old and behind the head still answers `head_moved`. The organiser portal drops an expired preview: the spreadsheet import asks the organiser to press Preview, which uploads the chosen sheet again, and the events and guests editors close the preview and ask for Save again, with no reload offered.
