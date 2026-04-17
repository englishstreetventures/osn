---
"@osn/db": minor
"@osn/api": minor
"@osn/client": patch
---

feat(auth): server-side sessions with revocation (Copenhagen Book C1)

Replace stateless JWT refresh tokens with opaque server-side session tokens.
Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.
