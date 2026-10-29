---
type: llm
weight: 1
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review. The branch `fix/cire-api-guest-session-ttl` changes `SESSION_TTL_SECONDS` in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts` from `30 * 24 * 60 * 60` to `14 * 24 * 60 * 60`, adds a correct `@cire/api` changeset, and edits `wiki/systems/cire-auth.md`. On that page it updates line 48 (`14-day TTL, host-scoped`) and line 53 (`a 14-day credential`) but leaves the Transport row of the table at line 26 saying `` `cire_session` HttpOnly cookie (30 days) ``, and does not bump `last-reviewed` (line 14). It also renames the heading at line 56 from `### Claim-code format (C1)` to `### Claim-code format`.

PASS if the finding on the Transport row's 30 days is tiered `D-C` or `D-H`.

FAIL if there is no such finding, or it is tiered `D-M` or `D-L`.

FAIL also if the file is missing or empty.
