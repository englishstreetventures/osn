---
type: llm
weight: 2
focus: { source: file, path: DOCS-REVIEW.md }
---

The file is a docs review. The branch `fix/cire-api-guest-session-ttl` changes `SESSION_TTL_SECONDS` in `cire/api/src/routes/claim.ts` and `cire/api/src/routes/account-link.ts` from `30 * 24 * 60 * 60` to `14 * 24 * 60 * 60`, adds a correct `@cire/api` changeset, and edits `wiki/systems/cire-auth.md`. On that page it updates line 48 (`14-day TTL, host-scoped`) and line 53 (`a 14-day credential`) but leaves the Transport row of the table at line 26 saying `` `cire_session` HttpOnly cookie (30 days) ``, and does not bump `last-reviewed` (line 14). It also renames the heading at line 56 from `### Claim-code format (C1)` to `### Claim-code format`.

PASS if the report identifies the Transport row of the table in `wiki/systems/cire-auth.md` (line 26, `cookie (30 days)`) as contradicting the code on the branch, which sets 14 days, checked against `SESSION_TTL_SECONDS` in the routes and not only against the page's other lines.

FAIL if the row is not reported, the code is not cited, or the report treats the page as consistent with the code or asserts the cookie lasts 30 days.

FAIL also if the file is missing or empty.
