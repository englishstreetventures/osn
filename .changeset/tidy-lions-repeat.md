---
"@osn/api": patch
"@pulse/api": patch
---

Serve the OpenAPI docs on `local` and `dev` only

The Scalar UI at `/openapi` and the document at `/openapi/json` are now mounted
on the `local` and `dev` tiers only; on `staging` and `production` the plugin is
never mounted and both paths 404.

The document maps every route, parameter and error shape, and nothing reads it
at runtime — `shared/openapi/{osn,pulse}.json` are committed, the generated
clients are built from those files, and each generator boots its own app to
produce one. A deployed public host gains nothing by serving it.

Both gates take the tier from the request-scoped `env.OSN_ENV` binding rather
than `process.env`, which workerd leaves empty during module evaluation; a
decision made at import time would read `local` on every deployed tier. They
fail closed, so an unrecognised tier string leaves the docs off.

`pulse/api/wrangler.toml` now sets `OSN_ENV` on `staging` and `production`. That
var also drives the cookie `Secure` flag, the plaintext-JWKS refusal and the
fail-closed CORS check, all of which were inert on those tiers because the var
was never set. Neither tier has ever deployed (both still carry placeholder D1
ids), and both will now refuse to boot until their CORS and issuer vars are
real — which is the intended posture.
