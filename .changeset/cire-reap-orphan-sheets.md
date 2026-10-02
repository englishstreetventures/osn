---
"@cire/api": patch
---

The daily cron deletes `cire-sheets` objects that no `imports` row names once they are seven days old, up to 500 a run, counting deletes on `cire.r2.objects.swept` with `bucket=sheets`. It lists at most 1,000 objects a run and resumes where the last run stopped, keeping its place in `reconcile/imports-position.json` in the same bucket, so a larger bucket is covered over several days; it asks D1 only about the keys it listed. Before deleting anything it checks that lookup against a key it knows is live, and it shares one guarded walk with the `cire-assets` reconciler. The guest-data retention sweep also deletes each expired change's before-image, which it previously left behind.
