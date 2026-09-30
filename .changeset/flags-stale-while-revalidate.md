---
"@shared/feature-flags": minor
---

`forRequest` takes an optional second argument, `{ waitUntil }`. Given one, a
stale cached payload answers at once and its refresh runs in the background
under that `waitUntil`; only a cold isolate with no payload waits on the CDN.
Callers that pass none keep the in-line refresh.
