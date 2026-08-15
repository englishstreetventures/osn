---
"@cire/host": patch
---

Apply the review gate to the host RSVP search and filter. Each row now carries the lower-cased text it matches on, built once at merge time instead of per keystroke; the merge and the filter each run once per render rather than four times per event; the status tallies count the merged rows the list already holds. Each row's Edit or Record button names the guest it belongs to, the match count is announced to screen readers on a short delay instead of on every keystroke, and an open editor closes when a filter hides its row.
