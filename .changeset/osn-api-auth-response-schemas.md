---
"@osn/api": minor
---

Declare `response:` schemas for the core session-lifecycle auth routes, and stop the OpenAPI document dropping `/.well-known/*`.

Fourteen operations — handle availability, registration, `/token`, logout, passkey login, session introspection and revocation, profile list and switch, OIDC discovery and JWKS — now declare TypeBox `response:` schemas and an `operationId`. Shared shapes (`errorResponse`, `tokenResponse`, `publicProfile`, `sessionSummary`, the WebAuthn request options) live in a new `routes/auth/response-schemas.ts`.

These schemas are not documentation. Elysia validates and *cleans* every response against them at runtime: an undeclared key is deleted from the body before it is sent, and a value that fails its type check turns the route into a 500. Each schema here was written against the handler's actual return value and the service's return type rather than the endpoint's intent. The JWK object carries `additionalProperties: true` for exactly that reason — a JWK field the schema forgot would be silently stripped from the document every relying party verifies signatures against.

`jwtPublicKeyJwk` on `AuthConfig` is now typed as jose's `JWK` rather than `Record<string, unknown>`, because a property of type `unknown` satisfies no TypeBox schema. The three `as Record<string, unknown>` casts at its call sites are gone.

The generated document also gains `/.well-known/openid-configuration` and `/.well-known/jwks.json`, which had never appeared in it: `@elysiajs/openapi` decides a route serves a static file when its path contains a dot, and dropped both. No route in `@osn/api` serves a file, so the heuristic is now off.
