---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of `@shared/osn-auth-client`. `verifyTokenWithKey` in `shared/osn-auth-client/src/verify.ts` calls `jwtVerify` with `algorithms`, `audience` and `clockTolerance` and no `requiredClaims`. `jose` checks `exp` only when the claim is present, so a token minted without `exp` verifies for as long as the signing key lives, and nothing else in the path looks at token age.

PASS if the review's finding on the missing `exp` requirement proposes `requiredClaims: ["exp"]` on the `jwtVerify` call, or an equivalent explicit expiry check.

FAIL if there is no such finding, or it proposes no remedy.

FAIL also if the file is missing or empty.
