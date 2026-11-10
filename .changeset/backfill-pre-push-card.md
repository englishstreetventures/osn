---
"@tools/pr-metrics": patch
---

`backfill` treats a card that names no pull request, on the same branch, as
that pull request's own: the card `retro` commits before a branch's first push
keeps its review counts and its rating when `backfill` fills in the number.
