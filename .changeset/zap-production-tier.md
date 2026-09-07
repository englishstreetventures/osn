---
"@zap/api": patch
---

Build out zap-api's production tier, and make its three environment discriminators agree.

`[env.production.vars]` never named the tier. Three separate readers each decided
"is this deployed?" from a different variable — the CORS guard read `ZAP_ENV ?? OSN_ENV`,
the ARC bridge read `OSN_ENV`, and its plaintext-URL check read `NODE_ENV`, which workerd
never populates from wrangler `[vars]` under that name. One Worker, three answers, and
every one of them resolved to "local" in production. All three now call one predicate in
`src/lib/deployment-env.ts`, and the production block sets `ZAP_ENV = "production"`.

The fail-closed CORS guard was also defeated by its own call site: `resolveCorsOrigins`
was handed `{ ZAP_CORS_ORIGIN }` alone, so its tier check saw an empty object, read
"local", and returned the localhost dev fallback — a non-empty list, which then sailed
past the assert that exists to catch exactly this. A production Worker would have
allowlisted `http://localhost:1420`. It now takes the whole environment, and the guard
tests whether a policy was *declared* rather than whether the list is empty, so
`ZAP_CORS_ORIGIN = "none"` is an explicit "serves no browser origin" (which production is,
until a browser client ships) while an omitted variable still refuses to boot.
