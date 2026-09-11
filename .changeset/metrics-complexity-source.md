---
"@tools/pr-metrics": patch
---

Read `backfill`'s declared-complexity rating off the pull request's linked
issue, not the pull request itself — this repository never puts a
`complexity:` label on a pull request. Scoped to issues linked from
xchromo/osn; a tracker-linked issue is left exactly as before pending
xchromo/osn#1012.
