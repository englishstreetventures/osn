---
"@osn/api": patch
---

Reject event creation when `startTime` is not strictly in the future. The events service now returns a `ValidationError` (HTTP 422) if the supplied `startTime` is at or before the current moment, preventing past-dated events from being created.
