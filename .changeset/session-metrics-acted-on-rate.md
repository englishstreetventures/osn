---
"@tools/pr-metrics": minor
---

Cards now record model calls (`interaction.requests`: calls, how many ran one
tool, median and 90th-percentile context per call) and, from the review reports
at the checkout root, whether tests and docs findings led to a change against a
control line 35 lines away (`review`). `report` gains two tables for them and
`--split-at <commit>`, which compares cards whose sessions ran before a commit
landed with those after. `queries.sql` runs again on DuckDB 1.5, where `window`
and `at` are keywords.
