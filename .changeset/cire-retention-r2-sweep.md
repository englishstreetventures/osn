---
"@cire/api": patch
---

Retention sweep now reclaims the R2 objects it orphans (IB-S-L2 / C-H1, data
erasure). The daily 1-year guest-data retention sweep deleted expired weddings'
`imports` DB rows but never the uploaded guest/event spreadsheets they
referenced in the `cire-sheets` bucket — D1's `ON DELETE cascade` fans out
within D1 but never reaches R2, so those CSVs (which carry guest PII) were
orphaned forever.

- `retentionService.sweepExpiredGuestData(now, { sheets })` now **collects each
  expired wedding's `events_r2_key`/`guests_r2_key` BEFORE the D1 deletes**
  (once the rows are gone the keys are unrecoverable), runs the existing
  all-or-nothing D1 delete batch, **then** best-effort deletes those objects
  from the `SHEETS` binding. The cron `scheduled` handler passes `env.SHEETS`.
- New reusable, bucket-agnostic `services/r2-cleanup.ts` `reapR2Objects(bucket,
  label, keys)`: dedupes + chunks (≤1000 keys/request), tries the R2 multi-key
  `delete([...])` first and falls back to per-key deletes, is **best-effort**
  (a failed chunk is `Effect.logError`'d with chunk index + count only — never
  keys or guest data — and swallowed so the sweep never aborts), and emits the
  bounded-cardinality `cire.r2.objects.swept` counter (`bucket` ∈ sheets|assets,
  `result` ∈ ok|error).
- The `cire-assets` invite images (hero/story/event) are deliberately **not**
  reaped: the retention sweep keeps the wedding/events shell and the live
  invite, so those rows survive and keep pointing at their objects (deleting
  them would 404 the live invite). That orphan path (re-upload-failure orphans +
  a future wedding-DELETE fan-out, which would reuse `reapR2Objects` for the
  `ASSETS` bucket too) stays an open IB-S-L2 / C-H1 follow-up. No organiser
  wedding-delete flow exists today, so the retention sweep was the only orphan
  source to hook.

No DB migration (purge logic only).
