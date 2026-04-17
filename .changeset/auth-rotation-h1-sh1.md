---
"@osn/db": minor
"@osn/api": minor
"@osn/client": minor
"@shared/observability": patch
---

feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

- **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
- **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
- **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
- Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.
