---
"@tools/pr-metrics": patch
---

Leave a card alone when the only field that would change is `generated_at`.
That timestamp records when a run happened, not a fact about the pull request,
so re-running the tool over settled work rewrote the file for nothing — the
last backfill produced 15 one-line timestamp diffs out of 25 cards. Both
writers now compare the new card against the one on disk with the old
timestamp substituted in, and the backfill reports how many it left untouched.
