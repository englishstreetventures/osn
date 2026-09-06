# Security-review `feat/shared-osn-auth-client`

You are in a checkout of the repository, on the branch `feat/shared-osn-auth-client`. The branch adds `@shared/osn-auth-client` — the package every downstream service uses to authenticate a request carrying a user access token. It resolves the signing key from the issuer's JWKS, caches keys by `kid`, verifies the bearer token and derives the caller's profile id.

Review this branch's diff against its base and report your findings in this repository's review conventions.

## Environment

- There is no network. `git push` and every `gh` command will fail. Propose issues in your report rather than claiming to have filed them.
- Package tooling is not installed. Do not run `bun install` or the test suite — read the code instead.
- This is a review, not a fix. Do not modify source files.

## Deliverable

Write your findings to `SECURITY-REVIEW.md` at the root of the repository. That file is the only thing that gets read — a finding stated anywhere else does not count as found.
