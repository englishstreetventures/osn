---
"@shared/crypto": patch
---

Narrow `generateArcKeyPair`'s return instead of leaning on the caller's
tsconfig. `crypto.subtle.generateKey` is typed `CryptoKey | CryptoKeyPair`
because it serves symmetric algorithms too; ECDSA always yields the pair, so
the function now checks for `privateKey` and returns the narrowed value.
