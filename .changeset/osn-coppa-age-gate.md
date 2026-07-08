---
"@osn/api": minor
"@osn/client": minor
"@osn/ui": minor
---

C-H8: COPPA under-13 age gate on registration.

`POST /register/begin` now requires a `birthdate` (`YYYY-MM-DD`). The
registration service validates the date format (`BirthdateSchema`) and then
hard-rejects any registrant under 13 with a new `AgeRestrictionError` →
HTTP 422 `{ error: "age_restricted", message: "OSN is for users 13 and older" }`
— **before** any collision probe or OTP dispatch, so OSN never gains "actual
knowledge" of a child's data. The birthdate is a transient argument and is
never written to any store or table (no rejected or accepted DOB retained).

The client SDK's `beginRegistration` gains a required `birthdate` field, and
`@osn/ui`'s `Register` form adds a date-of-birth input that mirrors the gate
client-side for immediate feedback (the server remains authoritative). The
legacy, unrouted `registerProfile` seed helper is intentionally left ungated.

Also hardens `publicError`: `Effect.runPromise` rejects with a `FiberFailure`
that stores the tagged error under a symbol-keyed `Cause`, which the previous
walker never traversed — so every Effect failure silently fell through to the
default 400. The walker now descends through all own keys (including symbols)
and skips Effect's internal Cause tags, so tagged errors like
`AgeRestrictionError` (422) map to their real status.
