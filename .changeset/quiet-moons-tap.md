---
"@pulse/api": patch
---

Cover the `/account` routes' session-cookie credential, and stop the auth-gate cases building a database they never touch.

`makeCallerResolver` accepts two credentials — a bearer access token and the `pulse_web_session` cookie — and every `/account` test used the bearer. Those are the DSAR-critical handlers (delete, restore, deletion-status) and the web app cannot present a bearer token, so if the routes stopped forwarding `headers["cookie"]`, or a handler read `headers.authorization` directly instead of going through `resolveCaller`, every web client would lose them with the suite still green. Three cases now exercise the cookie path, including a cookie that names no live session — without that negative, the positives would pass just as happily against a handler that authenticated nobody.

The auth-gate block also built a fresh schema-applied in-memory database and a `ManagedRuntime` per case, for requests rejected inside `resolveCaller` before any handler runs. Those share one app now; the one case in the block that does reach a handler keeps its own.
