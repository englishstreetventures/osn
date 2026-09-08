---
"@tools/pr-metrics": minor
---

Add `report --json`, so an agent reading the analyses does not have to parse ASCII columns back into numbers.

Each table keeps its `note` in the JSON alongside its rows. That is deliberate rather than incidental: the note holds the exclusions, and a consumer that reads only rows will state a ranking's conclusion without its "18 cards excluded" qualifier — which is the same failure that made `cire/host` look like the worst-mapped package in the repository, arriving by a different route.

Paired with a new `analyse-sessions` skill that reads coverage before anything else and carries the four traps this data has already sprung.
