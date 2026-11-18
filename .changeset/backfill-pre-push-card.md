---
"@tools/pr-metrics": patch
---

`backfill` treats a card that names no pull request, on the same branch and
written inside a pull request's record window, as that pull request's own: the
card `retro` commits before a branch's first push keeps its review counts and
its rating when `backfill` fills in the number. On a reused branch name, such a
card written after an earlier pull request merged is never credited to that
earlier one, nor written over.
