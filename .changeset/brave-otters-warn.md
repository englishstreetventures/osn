---
"@shared/db-utils": patch
"@osn/db": patch
"@osn/api": patch
"@pulse/db": patch
"@zap/db": patch
---

Enforce foreign keys on `bun:sqlite`, and fix the two erasure bugs that were hiding behind it.

SQLite defaults `PRAGMA foreign_keys` to **OFF** while D1 enforces them, so every local run and every test accepted writes production rejects. The cheap, fast environment was the permissive one, which is the worst way round: a statement that orphans a row, or deletes a parent before its children, passed the whole suite and would have failed on deploy.

Turning it on found `hardDeleteAccount` broken in two ways, both of which would make GDPR Art. 17 erasure throw rather than complete. It deletes the `accounts` row while deliberately keeping `security_events` and `email_changes` under Art. 6(1)(c) — but both declared a foreign key to `accounts`, so a column documented to outlive its parent referenced it. Those two constraints are dropped. It also deleted `users` before the `oauth_consents` and `oauth_authorization_codes` rows that carry a `profile_id` referencing them; those deletes now run first.

`dev-login`'s provisioning batch declared itself infallible through `Effect.promise` while being a chain of inserts that reference rows an earlier `onConflictDoNothing` may have skipped. With foreign keys on, that arrived as a defect and escaped the route's own error handling, answering 400 where the contract says 500 `provisioning_failed`.
