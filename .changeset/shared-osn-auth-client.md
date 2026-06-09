---
"@shared/osn-auth-client": minor
"@pulse/api": patch
---

Extract OSN access-token verification + JWKS cache into a new shared
package, `@shared/osn-auth-client`, with per-framework middleware
adapters (Hono + Elysia). Pulse switches to consuming the shared
verifier; cire will follow in a later phase.
