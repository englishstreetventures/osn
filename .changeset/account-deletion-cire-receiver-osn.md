---
"@osn/api": minor
"@osn/db": minor
"@musubi/infra": minor
"@shared/dev-urls": minor
"@shared/observability": minor
"@tools/e2e": patch
---

The account deletion reaches cire: cire is the third app in `DELETION_APPS` (audience `cire-api`), with `deletion_jobs.cire_done_at`, which reads as pending on a row written before the column. osn-api reads cire-api's origin from `CIRE_API_URL`, renamed from `CIRE_INTERNAL_REVOKE_URL`, for both the deletion and the organiser-session revoke; on a deployed tier a value that is not `https:` now refuses the boot. The musubi stack sets it on dev and production, the dev URLs and the E2E stack set it locally. `DELETE /account` ends the person's cire organiser sessions through that revoke (trigger `account_deletion`) when it schedules a deletion. No app is sent the person's email address any more: `receivesEmail` and the `email` field of `POST /internal/account-deleted` are gone. `DeletionFanoutService` gains `cire`.
