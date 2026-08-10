---
"@cire/api": patch
---

Read the OIDC relying-party flow from `@shared/osn-auth-client` instead of
keeping a private copy.

`lib/opaque-token.ts` and `services/oidc-login.ts` are deleted; `lib/cookie.ts`
is now nine thin wrappers naming cire's three cookies over the shared codec.
The fake issuer in `test-helpers/oidc-issuer.ts` re-exports the shared one with
cire's return origin bound in.

One new constant, `lib/oidc.ts`'s `CIRE_OIDC_TX_HMAC_INFO` — the HKDF `info`
cire derives its transaction-cookie MAC key under, imported by both the runtime
config and the test helper so the two cannot drift. Changing it invalidates
only in-flight transactions, which live ten minutes, so a bump costs at most
one retried sign-in.

`OrganiserIdentity` is now an alias of the shared `OsnIdentity`. Pure refactor:
no route, cookie or wire format changed.
