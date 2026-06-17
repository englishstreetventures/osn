---
"@cire/api": minor
---

Enforce the 1-year guest-data retention promise with a scheduled sweep.

cire's privacy notice promises guest data is deleted 1 year after the final
wedding event. A new `retentionService.sweepExpiredGuestData(now)` Effect
deletes the personal data — `rsvps` (incl. special-category dietary text +
`dietary_consent_at`/`dietary_consent_version`), `guests`, and `families`
rows, plus the wedding's `imports` bookkeeping rows — for every wedding whose
latest event date is more than `RETENTION_AFTER_FINAL_EVENT_MS` (365 days)
before now. The wedding + events shell is kept; weddings with no events are
kept (the window cannot be proven to have lapsed). It runs alongside the
existing session sweep on the same daily cron, with a `cire.guest_data.swept`
metric counting reclaimed guest rows.

The uploaded-sheet R2 objects behind expired `imports` rows are not yet
reaped (the sweep has no R2 binding) — tracked as a TODO for a separate
R2-aware pass / lifecycle rule.
