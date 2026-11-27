---
"@shared/db-utils": minor
"@osn/api": minor
"@zap/api": minor
"@shared/infra": minor
"@musubi/infra": minor
"@zap/infra": minor
---

Each accepted erasure request is recorded outside the database before it is written, so a D1 restore cannot lose it. `@shared/db-utils/deletion-records` holds the record (its kind, its time and ids only; the encoder refuses anything else), the R2, memory and missing stores, `withDeletionRecord`, which discards the record of a request refused after it was written, and `settleDeletionRecord`, which writes a request's outcome over its record or drops it, trying a failed store once more and logging a failure by kind, reason and key. osn-api records `DELETE /account`, `POST /account/restore` and `POST /profiles/delete`; zap-api records the account erasure osn-api's fan-out asks of it. A request whose record cannot be written answers 503 and writes nothing; a cancel goes ahead and logs the failure. The musubi and zap stacks declare `osn-deletion-records` and `zap-deletion-records`, private, each record deleted after 31 days, bound as `DELETION_RECORDS`, and production adopts them (`deletionRecordsBucket` in `@shared/infra`).
