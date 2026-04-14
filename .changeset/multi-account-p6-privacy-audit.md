---
"@osn/core": patch
"@osn/db": patch
"@shared/observability": patch
---

feat(core): Multi-account P6 — Privacy audit

- Add `passkeyUserId` column to `accounts` table (random UUID, generated at account creation) to prevent WebAuthn-based profile correlation — passkey registration now uses this opaque ID instead of `accountId` as the WebAuthn `user.id`
- Add `accountId` / `account_id` to the observability redaction deny-list as defence in depth against log-based correlation
- Add privacy invariant test suite verifying `accountId` never leaks in API responses, token claims, or profile data
- Audit confirmed: all route responses, span attributes, metric attributes, and rate limit keys are clean
