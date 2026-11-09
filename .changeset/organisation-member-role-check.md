---
"@osn/db": patch
"@osn/api": patch
"@pulse/db": patch
"@zap/db": patch
---

The identity database refuses an organisation member role other than `admin` or `member`. A migration adds two triggers, one on insert and one on update, and stops without changing anything if a stored row already holds another role; its header gives the recovery. `@osn/db/testing` adds the same triggers to every test database, and `db:push` adds them to the local database after `drizzle-kit push`. `@osn/api` gains a Miniflare D1 test of the refusals over the real migration chain. The pulse and zap lockstep tests name their own package in a comment.
