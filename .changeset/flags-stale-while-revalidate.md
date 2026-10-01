---
"@shared/feature-flags": minor
---

`forRequest` takes an optional second argument, `{ waitUntil }`. Given one, a
cached payload up to two TTLs old answers at once and its refresh, with the KV
write, runs in the background under that `waitUntil`; an older payload or none
is refreshed in line. Callers that pass none keep the in-line refresh.
