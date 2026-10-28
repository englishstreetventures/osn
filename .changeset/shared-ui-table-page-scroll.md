---
"@shared/ui": minor
"@tools/lab": patch
---

`Table` takes `scroll="page"`: the frame clips sideways instead of scrolling, so a pinned head row sticks to the page under the call site's offset; page mode has no tab stop and no region, and the table names itself. `label` is required in box mode only. `Table` also takes `frame="none"`, `Th` takes `srOnly` for a head kept for assistive technology under a visible copy, and `DropdownMenuItem` types `disabled`. The lab shows a table scrolling with the page.
