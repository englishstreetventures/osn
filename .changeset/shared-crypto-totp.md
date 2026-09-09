---
"@shared/crypto": minor
---

RFC 6238 TOTP primitives on a new `@shared/crypto/totp` subpath: secret
generation, RFC 4648 base32 both ways, `parseTotpSecret` for the base32 a user
types back, the `otpauth://` URI an authenticator app scans, code derivation
and verification. No new dependency — base32 is forty lines and HMAC-SHA-1 is
in WebCrypto, which Bun, Node and workerd all carry.

The subpath is the point. `src/index.ts` does not re-export any of it, because
the barrel reaches `@osn/db` and `drizzle-orm` through the ARC helpers, and a
caller deriving six digits should not load a database driver to do it. The
module imports `./timing-safe` and nothing else, and a test resolves
`@shared/crypto/totp` through the package's own `exports` map so a typo in that
map fails the suite rather than the first consumer.

Correctness rests on published vectors rather than on ones we chose: RFC 4226
Appendix D counters 0 to 9, all six SHA-1 rows of RFC 6238 Appendix B, and the
RFC 4648 §10 base32 strings in both directions. The base32 vectors earn their
place — a codec that is self-consistent but wrong, bits regrouped the wrong way
or the alphabet permuted, passes every round-trip test and is first noticed by
an authenticator app at enrolment.

`verifyTotpCode` derives every candidate in the drift window and compares all
of them with `timingSafeEqualString`, with no early return, so a valid and an
invalid six-digit code do the same work. It never throws: a malformed code, a
secret under RFC 4226's 128-bit floor, and an unusable date are all `false`,
and the drift window is clamped at both ends so a caller cannot choose how much
CPU one verification spends. A secret under the floor is run against a fixed
dummy secret rather than returned on, so `false` costs the same whether the
account has TOTP enrolled or not — "not enrolled" is an absent or empty secret
in every schema shape this sits behind, and the fast path would have answered
that question to anyone who could reach the route.

`base32Decode` validates before it case-folds — uppercasing maps `ß` to `SS`
and `ſ` to `S`, so the other order would admit characters that are not in the
alphabet — and its error message names no part of its input, which is a secret.
It refuses input over 512 characters before scanning it, since the length is an
unauthenticated caller's choice and decoding is linear in it. It stays a
general codec, returning whatever bytes the input carries: the 128-bit floor
lives in `parseTotpSecret`, which is what an enrolment route wants, because a
one-character input decodes to zero bytes without error. `totpUri` enforces the
same floor rather than committing an unusable secret to a QR code, and its
return value is documented as secret material — the shape most likely to be
logged carries the whole secret.
