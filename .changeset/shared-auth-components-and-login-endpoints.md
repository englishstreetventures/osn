---
"@osn/core": minor
"@osn/client": minor
"@osn/ui": minor
"@pulse/app": minor
---

Add shared in-app sign-in and registration across the OSN stack.

**`@osn/core`** — new first-party `/login/*` endpoints that return a
`Session + PublicUser` directly, mirroring the existing `/register/*`
flow with no PKCE round-trip:

- `POST /login/passkey/{begin,complete}`
- `POST /login/otp/{begin,complete}` (enumeration-safe: `begin` always
  returns `{ sent: true }`)
- `POST /login/magic/{begin}` + `GET /login/magic/verify?token=…`

Service layer refactored to extract `verifyPasskeyAssertion`,
`verifyOtpCode`, and `consumeMagicToken` helpers so the direct-session
variants (`completePasskeyLoginDirect`, `completeOtpDirect`,
`verifyMagicDirect`) share verification logic with the existing
code-issuing variants. The hosted `/authorize` HTML + PKCE path is
unchanged and remains the third-party OAuth entry point.

**`@osn/client`** — new `createLoginClient({ issuerUrl })` factory
mirroring `createRegistrationClient`, with `passkeyBegin/Complete`,
`otpBegin/Complete`, `magicBegin/Verify` methods. Throws `LoginError`
on non-2xx. Returned sessions are already parsed via `parseTokenResponse`
and ready to pass to `AuthProvider.adoptSession`.

**`@osn/ui`** — new shared SolidJS components under `@osn/ui/auth`:

- `<Register />` — migrated from `@pulse/app` with a new `client` prop
  so it's decoupled from any specific app's env config.
- `<SignIn />` — new three-tab sign-in (passkey / OTP / magic) driving
  the new `/login/*` endpoints through an injected `LoginClient`. Auto-
  falls-back to OTP when WebAuthn is unsupported.
- `<MagicLinkHandler />` — invisible root-level component that exchanges
  a `?token=…` query param for a session and clears the URL.

Package now pulls in the SolidJS + Vitest + @simplewebauthn/browser
devDeps it needs to actually host these components.

**`@pulse/app`** — replaces the old `useAuth().login()` redirect to
`/authorize` with an in-app `<SignIn />` modal. Imports `<Register>`,
`<SignIn>`, and `<MagicLinkHandler>` from `@osn/ui/auth/*`; shared
`RegistrationClient` and `LoginClient` instances live in
`src/lib/authClients.ts` and are injected as props.
