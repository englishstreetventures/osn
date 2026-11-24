---
"@shared/infra": patch
---

The cire squash cases in the D1 ledger tests (S1 to S8) take the squash release's live directory as its baseline alone and apply every later migration as the release after it, over the repository's live directory and over it with one more migration, so they hold whatever migrations a later branch adds after the baseline.
