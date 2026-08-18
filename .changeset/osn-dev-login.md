---
"@osn/api": patch
---

Add a passkey-less dev sign-in (`GET|POST /dev/login`) for the `local` and `dev`
tiers, so the seeded wedding is reachable without enrolling a WebAuthn
credential.

A passkey is the only primary login factor, which leaves any seeded account
permanently locked out — a seed script cannot enrol a credential on its own
behalf. The route mints a **real** OSN session for one fixed principal
(`usr_dev_bootstrap_owner`, the id the cire seed writes as the seeded wedding's
owner), so the OIDC authorize/token chain, the organiser portal, the vendor
portal and `@osn/social` all run untouched. There is no bypass anywhere else in
the stack, no identifier parameter, and nothing to enumerate.

**Two gates, both fail closed**, both applied in `buildAppDeps` — `OSN_ENV` must
be unset (the repo-wide local default) or read as `local`/`dev`, and
`DEV_LOGIN_SECRET` must be set. Fail either and the routes are never mounted, so
the path answers 404 rather than a 401 that would admit the surface exists. The
tier list is its own, deliberately not an alias of the OpenAPI-docs gate, so a
later change to how docs are gated cannot quietly widen a credential bypass. The
secret is compared in constant time; the endpoint carries its own 10/min limiter,
per app instance, keyed on the resolved IP. The production deploy job now refuses
to run while `DEV_LOGIN_SECRET` is set on the production Worker.

`return_to` is optional and checked against `DEV_LOGIN_RETURN_ORIGINS` — its own
comma-separated var, **not** the CORS allowlist, because a redirect target need
not be an origin that fetches this API with credentials and `OSN_CORS_ORIGIN`
also feeds the CSRF origin guard. Unset ⇒ every `return_to` is a 400, so the
endpoint cannot become an open redirect that leaks the session cookie. The check
runs before the secret compare, and both verbs answer `Referrer-Policy:
no-referrer` so the secret-bearing URL never reaches the target. `GET` is the
primary verb: the origin guard rejects a POST without a matching `Origin`, and a
URL keeps the secret out of every public frontend bundle.

The principal is provisioned idempotently on first use (`onConflictDoNothing`
inside a single `commitBatch`), since `osn-db-dev` is never reset. Its handles
`dev_bootstrap` and `dev_bootstrap_org` are now in `RESERVED_HANDLES` so no real
registration can occupy the row first — and organisation creation now consults
that set too, which also closes a pre-existing gap that let `admin`, `api` and
friends be taken as organisation handles.
