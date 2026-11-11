---
"@osn/api": patch
---

`POST /recovery/generate` and the step-up completions that call the new `liveSessionGate` answer `409 { error: "session_stale" }` unless the caller holds a live session: its session cookie, or its access token's `osn_sid` binding, must name an unrestricted, unexpired session of the same account. The gate runs before any factor is read or spent, so a refusal mints no step-up token, records no authenticator-app step and leaves the recovery codes and the step-up token untouched. It lives on the auth route context, over the new `holdsLiveOrdinarySession` service read; refusals count on `osn.auth.session.stale_refused{endpoint}`.
