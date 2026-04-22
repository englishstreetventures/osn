---
"@osn/api": major
"@osn/client": major
"@osn/ui": patch
"@osn/social": patch
"@pulse/app": patch
"@shared/observability": minor
---

Remove legacy OAuth authorization-code / PKCE flow.

The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
are now the only sign-in surface. The following are gone:

- Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
  `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
  `POST /magic/begin`, `GET /magic/verify`
- Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
  `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
- Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
  errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
  `OsnAuthConfig.clientId`
- Solid context methods `login` / `handleCallback`
- `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
- Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
- Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
Magic-link emails point at `/login/magic/verify` (consumed client-side by
`MagicLinkHandler`).
