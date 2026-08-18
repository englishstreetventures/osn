---
"@osn/api": patch
"@osn/client": patch
"@osn/ui": patch
"@pulse/api": patch
"@zap/api": patch
"@shared/db-utils": patch
"@shared/observability": patch
"@shared/openapi-tools": patch
"@shared/redis": patch
---

Clear every `anti-slop/no-unknown-returns` hit in application source and raise
the rule from `warn` to `error`. A function returning `unknown` hands its caller
a value with no contract, so every site either had a shape worth naming or was
returning a value nobody read.

The three `arc-middleware.ts` copies (osn, pulse, zap) now decode a JWT segment
to text and parse it through `parseArcHeader` / `parseArcPayload`, which narrow
with `in` checks and contain no type assertions at all. `zap-bridge.ts` gains
four named response types and a parser per endpoint, so a malformed zap-api
reply throws at the bridge — naming the endpoint — instead of surfacing as an
`undefined` field several layers up. `safe-error.ts` and `grant-failure.ts`
share a `TaggedServiceError` guard in place of duck-typed shape checks.

`shared/redis` exports a recursive `RedisReply` and narrows ioredis's `unknown`
through `toRedisReply()` once, at the driver boundary. `shared/observability`'s
redactor returns a `RedactedValue` union, and `shared/openapi-tools` normalises
through a `JsonNode` union that throws on anything JSON cannot represent.
`@osn/ui` exports `RunPasskeyCeremony` and `RunPasskeyRegistration` so the four
step-up call sites name the ceremony callback instead of typing it
`(options: unknown) => Promise<unknown>`, and `@osn/client`'s two registration
begins return `PublicKeyCredentialCreationOptionsJSON`.

Test files still hold 18 hits, all in fetch/JSON helpers, so the rule stays off
in the test override.
