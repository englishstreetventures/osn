---
"@shared/realtime": minor
---

`publish()` tries the hub again when a call that revokes members fails: after
each pause in the new `REVOKE_RETRY_DELAYS_MS` (250 ms, then 750 ms), inside the
same effect, so inside the caller's `waitUntil`. When every try fails it logs
`realtime revoke failed` instead of `realtime publish failed`. A publish that
revokes nobody still tries once. `PublishOptions.revokeRetryDelaysMs` overrides
the pauses.
