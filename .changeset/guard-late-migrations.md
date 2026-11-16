---
"@shared/infra": patch
---

The production plan guard refuses a release whose database has a timestamped migration that sorts before one its ledger already records, since Alchemy from `2.0.0-beta.86` refuses to apply it.
