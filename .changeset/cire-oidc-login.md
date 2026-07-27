---
"@cire/api": patch
"@cire/organiser": patch
"@cire/vendor": patch
"@cire/web": patch
"@cire/db": patch
---

Sign cire people in through the OSN OIDC redirect instead of a local passkey call.

Identity moved to `musubi.social` on 2026-07-27, so a `cireweddings.com` origin
can no longer run a passkey ceremony — the RP ID no longer matches. cire now
redirects to the issuer and never touches WebAuthn itself.

- `@cire/api`: new `/api/auth/oidc/*` — `start` builds the authorize URL with
  PKCE S256, `callback` exchanges the code server-side, and `session` / `signout`
  serve the cire session. The exchange mints an opaque 256-bit `cire_org_session`
  cookie (SHA-256 at rest in the new `organiser_sessions` table, `HttpOnly`,
  `SameSite=Lax`, 7 days), so the browser holds no OSN token. `osnAuth()` reads
  the cookie first and falls back to a bearer token for ARC and API callers. A
  token without `osn_profile_id` is refused (`token_invalid`) rather than falling
  back to the pairwise `sub`. All four of `OSN_ISSUER_URL`, `CIRE_API_ORIGIN`,
  `CIRE_OIDC_CLIENT_ID` and `CIRE_OIDC_CLIENT_SECRET` must be set, else the
  routes answer 503 `sign_in_unavailable` and the rest of cire works as normal.
- `@cire/db`: migration `0047_organiser_sessions`.
- `@cire/organiser`, `@cire/vendor`, `@cire/web`: sign-in and sign-out go
  through `@shared/rp-auth`; the passkey forms and `@osn/client` calls are gone.
  Passkey and recovery-code management deep-links to `musubi.social/settings`.
