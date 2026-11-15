---
"@shared/observability": minor
---

Add the attribute values account erasure reports: `StepUpPurpose` gains `account_restore`, `DeletionCompletedResult` gains `hard_failed` (a hard delete the sweep could not finish and will try again), and `AuthRateLimitedEndpoint` gains `account_deletion_preview`.
