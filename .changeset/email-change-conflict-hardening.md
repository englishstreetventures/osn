---
"@osn/api": patch
"@shared/observability": patch
---

Hardened the email-change ceremony against a race where two accounts complete
a change to the same address at once. The database-uniqueness check now only
catches a genuine UNIQUE-constraint violation, so any other write failure
correctly surfaces as a database error instead of being folded into the same
generic message. When a change loses that race, its now-stale pending entry
is deleted rather than left behind. The write path's pre-check now reads
only the one column it needs from the account.

Metrics gained a `metricResult` override: an error can now name its own
outcome bucket directly, taking precedence over the usual message-keyword
classification. This lets the email-change conflict path report as
`conflict` instead of `validation_error`. `@shared/observability` exports its
`RESULT_VALUES` runtime tuple alongside the existing `Result` type so
downstream packages can build this kind of override without redefining the
set of allowed outcomes.
