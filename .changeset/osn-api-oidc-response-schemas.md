---
"@osn/api": patch
---

OIDC route group — response schemas and stable operation ids (PR 4 of the
`shared/openapi/osn.json` series). Covers `routes/auth/oidc-clients.ts` (client
registration, list, disable) and `routes/auth/oidc.ts` (`/authorize`,
`/authorize/context`, `/authorize/decision`, `/oidc/token`,
`/oidc/connections`). Nine operations that previously generated with an empty
`responses` object — and so a `Void` return in any generated client — now
describe every status they can emit.

Two things about this group are unlike the ones before it.

The OIDC routes emit **two different error envelopes at the same status**.
Their own refusals use the RFC 6749 §5.2 `{ error, error_description }` shape;
the shared rate-limit gate and `handleError` use the house
`{ error, message }`. Elysia's `response:` schemas clean as well as validate —
an undeclared key is deleted from the body before it is sent — so a schema
carrying only the RFC pair would silently blank the message on a 429 or a 500.
`oidcErrorResponse` is therefore a superset of both, with `error_description`
and `message` each optional, rather than a union.

`GET /authorize` is the only route in the auth surface whose body is sometimes
a string. It answers a browser navigation, not a fetch, and has three shapes:
an empty body at 302 (every success and every post-validation error, which
travels back to the relying party as query parameters); a rendered HTML page at
400/401/429, because RFC 6749 §4.1.2.1 forbids redirecting before the client
and redirect URI are trusted, so the user is stranded and gets a real page; and
a JSON error at 400/500 when a non-OIDC failure falls through `handleError`.
Its 400 is a `t.Union([t.String(), oidcErrorResponse])` for that reason —
declaring only the object would have made Elysia reject the error page it was
rendering.

Four new schema consts in `routes/auth/response-schemas.ts`
(`oidcErrorResponse`, `ownedClientSummary`, `oidcConnectionSummary`,
`oidcTokenResponse`), each modelled on the service's literal return type rather
than the endpoint's apparent intent. Routes authenticated by session cookie or
client credentials get an `operationId` but no `security: [{ bearerAuth: [] }]`,
since a bearer token is not what authenticates them.

No behaviour change: the route set in `shared/openapi/osn.json` is identical
before and after, and `shared/openapi/pulse.json` regenerates byte-identical.
