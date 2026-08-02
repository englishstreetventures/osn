---
"@cire/api": patch
"@cire/organiser": patch
---

Share the organiser component-test mocks and the OSN test-token signer

`cire/organiser/src/test-support/mocks.ts` (new) holds the
`@shared/rp-auth/solid` + `solid-toast` + `lib/api` mock factories and their
spies, which 17 component suites were each re-declaring. `vi.mock` is hoisted
per module so registration stays in the test file; only the factory bodies move,
using the dynamic-import form that pulse/app already uses. Suites needing a
different shape (an extra `useAuth` field, an `importOriginal` spread) keep
their local mock.

`cire/api/src/test-helpers/osn-token.ts`'s `makeOsnTestAuth()` is now a thin
adapter over `@shared/crypto/testing`'s `makeAccessTokenSigner()`, so cire,
pulse and zap mint test access tokens from one implementation. Its `{ key, sign }`
shape is unchanged — all 16 cire call sites are untouched.
