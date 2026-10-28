---
type: llm
weight: 2
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of `@shared/osn-auth-client`, the package downstream services use to verify a user access token. `verifyTokenWithKey` in `shared/osn-auth-client/src/verify.ts` calls `jwtVerify` with `algorithms`, `audience` and `clockTolerance` and no `requiredClaims`. `jose` checks `exp` only when the claim is present, so a token minted without `exp` verifies for as long as the signing key lives, and nothing else in the path looks at token age.

PASS if the review carries a finding, not a dismissed note, that the `jwtVerify` call does not require `exp`, and says a token minted without one is accepted indefinitely.

FAIL if the finding is absent or dismissed, lacks that consequence, or the review asserts that expiry is enforced.

FAIL also if the file is missing or empty.
