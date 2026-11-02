---
"@osn/api": patch
---

`@simplewebauthn/server` moves to 14. The passkey begin routes keep their wire shape: credential descriptors still carry `type: "public-key"`, now set by `services/auth/webauthn-options.ts` because the library types it as any string. On the Worker the advertised algorithms stay EdDSA, ES256 and RS256; under Bun, which verifies ML-DSA-44, the library also offers ML-DSA-44 first.
