---
"@osn/db": minor
---

Regenerate the osn-db drizzle migration chain into a single clean baseline.

The previous chain (`0000`–`0009`) had drifted from the live schema during the accounts/users refactor: no migration created the `accounts` table, yet `0003`/`0004`/`0005`/`0006`/`0009` referenced it, so the chain could not apply to a fresh D1 (tests/local had been running off the schema directly, masking the break). The osn D1s are empty and nothing is deployed, so the chain was squashed into a single `0000` baseline generated from `osn/db/src/schema/index.ts`. The baseline applies cleanly from scratch (all 15 tables incl. `accounts`) and `wrangler d1 migrations apply` now works for the osn-db dev/staging/prod databases.
