---
"@shared/osn-auth-client": minor
"@shared/crypto": minor
---

Move the OIDC relying-party server half out of cire and into the shared
packages, so a second product can sign users in with an OSN account without
copying four files.

Three new entry points, all lifted verbatim from `cire/api` with the
product-specific parts turned into parameters:

- `@shared/crypto/tokens` — opaque token minting plus the SHA-256 hash stored
  at rest, the primitive behind every server-side session in the monorepo.
- `@shared/osn-auth-client/cookie` — the `Set-Cookie` builder and request-cookie
  parser. Host-scoped by construction: no `Domain=` attribute, so the cookie
  never widens to sibling subdomains. `SameSite=Lax` is required rather than
  merely tolerated — the OIDC callback arrives as a top-level cross-site GET,
  which `Strict` would strip the transaction cookie from.
- `@shared/osn-auth-client/oidc-rp` — `beginLogin` / `completeLogin` /
  `readReturnTo`, the PKCE transaction cookie, and the ID-token checks. A token
  without an `osn_profile_id` claim is refused outright; client authentication
  is `client_secret_post`, never Basic.
- `@shared/osn-auth-client/testing/oidc-issuer` — the fake issuer the flow is
  tested against, now product-neutral, with the return origin passed in.

`OidcConfig` gains a required `txHmacInfo`: the HKDF `info` the transaction
cookie's MAC key is derived under. It is required, not defaulted, because two
products sharing an OIDC client secret would otherwise derive the same key, and
one product's transaction cookie would verify at the other.

No behaviour change for cire, which now imports all of the above.
