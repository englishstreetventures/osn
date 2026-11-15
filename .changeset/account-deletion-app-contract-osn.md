---
"@osn/api": minor
"@osn/db": minor
"@osn/client": minor
---

Account deletion reaches every app through one contract. `GET /account/deletion-preview` asks each app (`POST /internal/account-deletion-preview`) what it holds beside the organisations the account owns, and names any app it could not check; `DELETE /account` takes `delete_everything`, answers 409 `could_not_check` while an app cannot be asked and 409 `stale_choices` for an answer to an app action the fresh preview no longer lists, and stores app answers on the job. Once the window has passed, the fan-out sends every app (`POST /internal/account-deleted`) the person's answers to its actions, their email address and the delete-everything flag, for every account, a job written with the old `-1` marks included, and stores what each app kept in `deletion_jobs.app_outcomes`. A failing job is stamped (`fanout_failed_at`) and read after the others; `OSN_DELETION_FANOUT_MAX_JOBS` caps the jobs and hard deletes per run; an app is skipped only on a local run without its URL or where `OSN_DELETION_ABSENT_APPS` declares it, and a deployed tier with neither holds the deletion. The soft delete ends the person's Pulse web sessions. `osn.account.deletion.fanout_oldest_age` records each app's oldest unfinished job.

osn-api publishes each isolate's outbound ARC public key in `arc_outbound_keys` and serves the set at `GET /.well-known/arc-jwks.json`; the registration it pushed to each app is gone. A deployed osn-api needs `INTERNAL_SERVICE_SECRET`, which keys the MAC its outbound key ids carry. `@osn/client`'s deletion preview carries each app's actions and `could_not_check`, and `deleteAccount` takes `deleteEverything`.
