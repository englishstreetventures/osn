---
"@cire/api": patch
---

The daily cron's two R2 orphan reconcilers (`cire-sheets` and `cire-assets`) gain three controls. A run in which the rows naming keys under the reconciler's prefix number fewer than half of what the previous run counted deletes nothing and logs `r2 reconcile held`; the count is read in the same statement as the lookup, kept beside the walk's position in `reconcile/<name>-position.json`, and replaced by each run, held runs included. `CIRE_R2_RECONCILE_DISABLED`, declared `"false"` in every `wrangler.toml` tier, leaves both reconcilers out of the cron when set to anything else, without stopping the other cron jobs. Every delete batch logs `r2 reconcile deleting orphan objects` at warning level and records its size on `cire.r2.reconcile.batch.size`.
