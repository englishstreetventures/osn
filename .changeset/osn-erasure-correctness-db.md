---
"@osn/db": minor
---

Add the schema account erasure needs to be undone and to hold handles. New table `handle_holds` (`handle`, a keyed hash and the primary key; `account_id`, set while the deletion is pending; `release_at`; `created_at`), indexed on `account_id` and `release_at`. `deletion_jobs` gains `restore` (what a cancel puts back), `choices` (the person's answers for owned organisations) and `hard_delete_failed_at`. `security_events` gains `security_events_created_at_idx` for the retention sweep. One migration, `20261114120712_account_erasure_restore.sql`; every new column is nullable and the new table starts empty.
