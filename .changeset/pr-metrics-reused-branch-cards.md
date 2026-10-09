---
"@tools/pr-metrics": patch
---

Give a second pull request on a reused branch name its own card. `card` and
`backfill` now write it to `.claude/metrics/<branch-slug>-<pr>.json`, built only
from the records after the earlier pull request's merge, and leave the earlier
card untouched. Where the earlier merge time is unknown, or that pull request
closed without merging, `card` refuses and `backfill` skips it. `backfill` also
skips a pull request whose records all fall outside its window, rather than
writing a zero-spend card.
