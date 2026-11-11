---
"@osn/api": patch
---

`POST /step-up/passkey/complete`, `POST /step-up/totp/complete` and `POST /recovery/generate` answer `409 { error: "session_stale" }` unless the caller holds a live session: its session cookie, or its access token's `osn_sid` binding, must name an unrestricted, unexpired session of the same account. The check runs before any factor is read or spent, so a refusal mints no step-up token, records no authenticator-app step and leaves the recovery codes and the step-up token untouched. Routes call it as `liveSessionGate` on the auth route context, over the new `holdsLiveOrdinarySession` service read; refusals count on `osn.auth.session.stale_refused{endpoint}`.
