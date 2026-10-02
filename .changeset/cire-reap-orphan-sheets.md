---
"@cire/api": patch
---

The daily cron deletes `cire-sheets` objects that no `imports` row names once they are seven days old, up to 500 a run, counting deletes on `cire.r2.objects.swept` with `bucket=sheets`. It lists at most 1,000 objects a run and resumes where the last run stopped, keeping its place in `reconcile/imports-position.json` in the same bucket, and asks D1 only about the keys it listed. Before deleting anything it checks that a key it knows is live is an object in the bucket and comes back from that lookup.

The `cire-assets` reconciler shares that walk: it too lists at most 1,000 objects a run and resumes from `reconcile/assets-position.json`, and reads its live keys in one statement instead of three.

The guest-data retention sweep also deletes each expired change's before-image, which it previously left behind, and sends its wedding and household id lists to D1 as one parameter each, so a cohort of more than 100 weddings or households no longer fails on D1's bound-parameter limit.
