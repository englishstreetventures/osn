---
"@cire/api": patch
---

Test only: the `waitUntil` timing test for co-host writes allows 1.8 s instead of
0.5 s before its response counts as late. The handler took 1.07 s on a loaded CI
runner. Nothing in the Worker changes.
