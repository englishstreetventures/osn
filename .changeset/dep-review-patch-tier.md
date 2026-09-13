---
"@osn/api": patch
"@osn/ui": patch
"@pulse/api": patch
"@shared/crypto": patch
"@shared/openapi-tools": patch
"@shared/osn-auth-client": patch
"@shared/redis": patch
"@zap/api": patch
---

Take the patch-tier dependency upgrades from the 2026-09-11 review: `jose`
6.2.10 → 6.2.12 (refactors and performance work on the JWS/JWE cores and the
JWKS key-import path, no semantic change to any acceptance check),
`@elysiajs/openapi` 1.4.15 → 1.4.16 (additive — OpenAPI 3.1, regex path scopes,
`withHeaders` headers), `@kobalte/core` 0.13.13 → 0.13.14 (three bug fixes,
including `aria-hidden` preserved during modal handoff) and `@upstash/redis`
1.38.3 → 1.38.4.

The `@upstash/redis` release is a read-your-writes fix, not the CI-only change
its commit range suggests: 1.38.3 wrote the `upstash-sync-token` header onto the
client *after* the request headers were merged, so the token only reached
Upstash on the following call and every read was one request behind on replica
consistency. `readYourWrites` defaults on and `shared/redis/src/upstash.ts` does
not disable it, so this covers the rate-limit counters and the ceremony stores.

`@elysiajs/openapi` 1.4.16 also changes what the generator emits, which the
OpenAPI freshness job catches: nullable schemas now carry `nullable: true`
beside a type array rather than beside an `anyOf`, and
`stripRedundantNullable` only recognised the `anyOf` spelling. It now accepts
either, so the shipped documents stay free of a keyword OpenAPI 3.1 does not
have. `shared/openapi/*.json` are regenerated: 3.1.2 rather than 3.1.0 (the
plugin sets the version itself now, so the hard-coded value in each app's
`documentation` block is dropped), and one `anyOf` of consts is emitted as an
`enum`. The Swift package builds against both regenerated documents.
