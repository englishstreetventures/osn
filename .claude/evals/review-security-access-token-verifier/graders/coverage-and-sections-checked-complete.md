---
type: llm
weight: 1
focus: { source: file, path: SECURITY-REVIEW.md }
---

The file is a security review of a branch whose diff is exactly these files:

- `shared/osn-auth-client/README.md`
- `shared/osn-auth-client/package.json`
- `shared/osn-auth-client/src/cookie.ts`
- `shared/osn-auth-client/src/index.ts`
- `shared/osn-auth-client/src/jwks-cache.ts`
- `shared/osn-auth-client/src/middleware/elysia.ts`
- `shared/osn-auth-client/src/oidc-rp.ts`
- `shared/osn-auth-client/src/options.ts`
- `shared/osn-auth-client/src/testing/oidc-issuer.ts`
- `shared/osn-auth-client/src/verify-id-token.ts`
- `shared/osn-auth-client/src/verify.ts`
- `shared/osn-auth-client/tests/jwks-cache.test.ts`
- `shared/osn-auth-client/tests/middleware-elysia.test.ts`
- `shared/osn-auth-client/tests/oidc-rp.test.ts`
- `shared/osn-auth-client/tests/verify-id-token.test.ts`
- `shared/osn-auth-client/tests/verify.test.ts`
- `shared/osn-auth-client/tsconfig.json`
- `shared/osn-auth-client/vitest.config.ts`

PASS if the file has no `##` heading beyond `## Security findings`, `## Compliance findings`, `## Coverage`, `## Sections checked`; `## Coverage` gives a one-line verdict for every file listed above (a finding ID, `clear`, or "not opened, because …"), including those it clears; and `## Sections checked` names each review area it treated as mandatory, with the file and line it looked at and a verdict. Line numbers cited in the findings need not be repeated under `## Sections checked`.

FAIL if an extra `##` section appears, a listed file has no Coverage line, a Sections-checked entry has no file beside it, or either section is missing.

FAIL also if the file is missing or empty.
