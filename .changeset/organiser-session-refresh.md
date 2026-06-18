---
"@osn/client": patch
---

Keep the organiser signed in across page reloads via the refresh cookie. On
reload the cached access token in `localStorage` is almost always expired (5-min
TTL), so `loadSession` previously reported the user as logged out and bounced
them to sign-in even though the 30-day HttpOnly refresh cookie was alive. It now
rehydrates an expired-but-`hasSession` account from the cookie via `POST /token`,
and the shared cookie grant retries transient failures (network / 429 / 5xx)
with bounded backoff while still failing fast on a terminal `invalid_grant`.
