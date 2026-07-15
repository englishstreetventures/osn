---
"@osn/api": patch
---

Test-hardening (test-only, no production behaviour change): add direct,
deterministic coverage for the refresh-rotation compare-and-swap (CAS)
family-revoke branch in `refreshTokens` (landed in #253).

Previously the happy path and the `verifyRefreshToken` → `detectReuse` reuse
path were tested, but the CAS-0-rows branch — where the session row is present
at verify time yet the rotation DELETE reports 0 rows affected (a concurrent /
replayed writer already rotated it out) — had no direct test. The new test
proxies the drizzle `Db` handle to force the DELETE to report 0 rows on demand
(the row is genuinely removed, mirroring a lost CAS) and asserts the reuse
guarantee: the whole session family is revoked, no sibling session is minted,
and the reuse / family-revoke metrics fire. A control case proves the
interception — not a broken layer — is what drives the branch.
