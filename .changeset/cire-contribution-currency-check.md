---
"@cire/db": patch
"@cire/api": patch
---

`registry_contributions` refuses a `currency` that is not three characters long, and a `primary_currency` that is neither NULL nor three characters long. Migration `20261103160929_contribution_currency_check.sql` rebuilds the table to add the two CHECKs and copies every gift across unchanged; the test DDL in `cire/api/src/db/setup.ts` declares the same two.
