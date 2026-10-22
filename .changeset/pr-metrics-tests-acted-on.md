---
"@tools/pr-metrics": minor
---

A tests review finding now counts as acted on when a commit after the review
added lines to a test file in the cited file's package that imports the cited
file, as well as when its cited line changed. The card's `review` block gains
`acted_on_by_test` and `acted_on_paired_by_test`, the report's review and
split tables gain a **by line** rate counted the way the control is, the
review row in the rendered block says how many findings a new test counted,
and `schema_version` is 2.
