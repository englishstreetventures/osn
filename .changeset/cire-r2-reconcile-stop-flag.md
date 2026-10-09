---
"@cire/api": patch
---

The daily cron's two R2 orphan reconcilers (`cire-sheets` and `cire-assets`) gain stops, a hold and operator email.

- An object at `reconcile/stop` in a bucket stops that bucket's reconciler before it reads anything; no deploy touches it, and while it is there the operator is emailed each run with how many days it has been in place. `CIRE_R2_RECONCILE_DISABLED`, declared `"false"` or `"true"` in every `wrangler.toml` tier, keeps both reconcilers out of the cron for a whole tier and emails the operator each run.
- The lookup that names live keys also counts the rows that name them, in the same scan. A run whose count is less than half of the stored one deletes nothing, emails the operator, and keeps the earlier count, so later runs hold too until the rows recover, an operator deletes the bucket's position object (`reconcile/imports-position.json` or `reconcile/assets-position.json`), or 7 runs have held; the next run then accepts the lower count, deletes, and says so.
- Every delete batch logs `r2 reconcile deleting orphan objects` at warning level and records its size on `cire.r2.reconcile.batch.size`.
- Alerts go to `CIRE_OPS_EMAIL` through Resend, as the vendor-claim reminder does, with two retries a few seconds apart.
