---
"@shared/crypto": patch
"@shared/osn-auth-client": patch
---

Split the pure ES256 key/JWK helpers into a DB-free entry point so the
JWKS-verification path no longer drags in `bun:sqlite`.

- `@shared/crypto`: pure ES256 key/JWK helpers (`importKeyFromJwk`,
  `generateArcKeyPair`, `exportKeyToJwk`, `thumbprintKid`, `ArcTokenError`)
  moved into a new DB-free `@shared/crypto/jwk` entry point. `arc.ts` and
  the barrel re-export them, so existing call sites are unchanged.
- `@shared/osn-auth-client` imports `importKeyFromJwk` from
  `@shared/crypto/jwk` instead of the barrel — this severs the
  `arc.ts → @osn/db → bun:sqlite` chain from the JWKS-verification path so
  the cire Worker (which runs `osnAuth`) bundles without `bun:sqlite`.
