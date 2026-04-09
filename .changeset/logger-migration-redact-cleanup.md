---
"@osn/core": minor
"@osn/app": patch
"@shared/observability": patch
---

Migrate dev-mode `console.log` of registration OTP, login OTP, and magic-link
URL in `osn/core/src/services/auth.ts` to `Effect.logDebug` (S-H21). The values
stay interpolated into the message string so the redacting logger doesn't scrub
them — the whole point of these dev branches is to expose the code/URL to the
developer.

`createAuthRoutes` and `createGraphRoutes` now accept an optional third
`loggerLayer: Layer.Layer<never>` parameter (defaulting to `Layer.empty`) which
is provided to the per-request Effect runtime alongside `dbLayer`. Without this
wiring `Effect.logDebug` calls inside auth services would be silently dropped
by Effect's default `Info` minimum log level, breaking local dev UX after the
migration. `osn/app/src/index.ts` now threads its `observabilityLayer` through
to both route factories (S-L1). The parameter is optional and backwards
compatible for any downstream caller.

Trim the redaction deny-list in `@shared/observability` to only the keys that
correspond to real object properties in the codebase today: `authorization`,
the OAuth token fields (`accessToken`/`refreshToken`/`idToken`/`enrollmentToken`
+ snake_case), the WebAuthn `assertion` body, ARC `privateKey`, and the user
PII fields `email` / `handle` / `displayName`. Removes ~30 speculative entries
(Signal/E2E keys, password fields, address/SSN/etc.) that were never reached.
`enrollmentToken` is added because it is a real bearer credential returned by
`/register/complete` and sent back as `Authorization: Bearer <token>` for
passkey enrollment (S-M1). Adds a documented criteria block at the top of
`redact.ts` explaining when to add or remove keys, a lock-step assertion in
`redact.test.ts` pinning the exact set, a positive assertion for the enrollment
token, and a behavioural regression anchor (T-S1) that proves previously-
scrubbed keys now pass through unchanged. Dev-log branch coverage is locked
with three new `it.effect` tests using a `Logger.replace` capture sink (T-U1).
