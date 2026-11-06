---
"@tools/oxlint-house": patch
---

`no-tracker-ref-in-comment` reports a state-review (`G-`) or design-review (`U-`) finding tag in a comment, as it does every other review finding tag. Its message for a finding tag now says the tag means nothing without the review that raised it, which holds for the public `G-` and `U-` tags as well as the tracker's.
