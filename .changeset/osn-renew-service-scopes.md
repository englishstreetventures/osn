---
"@osn/api": minor
---

New `PUT /graph/internal/service-scopes/:serviceId`, behind the `INTERNAL_SERVICE_SECRET` bearer like `/register-service`, sets the ARC scopes of a service that already has a row and a live key, with no key in the request. Scope names must match `PERMITTED_SCOPES` exactly; a service with no row answers 404 `unknown_service`, one whose every key is revoked or expired answers 409 `no_live_key`, and neither writes. The answer carries `staleForUpToSeconds`, how long an isolate may keep a key's old scopes. `/register-service` and the key revoke now share one bearer check, with the same 501 and 401 answers as before.
