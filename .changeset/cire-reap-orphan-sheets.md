---
"@cire/api": patch
---

The daily cron deletes `cire-sheets` objects that no `imports` row names once they are seven days old, up to 500 a run, walking at most 10,000 objects a run and counting deletes on `cire.r2.objects.swept` with `bucket=sheets`. It reuses the guarded walk the `cire-assets` reconciler now shares. The guest-data retention sweep also deletes each expired change's before-image, which it previously left behind.
