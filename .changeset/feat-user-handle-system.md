---
"@osn/db": minor
"@osn/core": minor
"@osn/api": patch
"@osn/pulse": patch
---

Add user handle system

Each OSN user now has a unique `@handle` (immutable, required at registration) alongside a mutable `displayName`. Key changes:

- **`@osn/db`**: New `handle` column (`NOT NULL UNIQUE`) on the `users` table with migration `0002_add_user_handle.sql`
- **`@osn/core`**: Registration is now an explicit step (`POST /register { email, handle, displayName? }`); OTP, magic link, and passkey login all accept an `identifier` that can be either an email or a handle; JWT access tokens now include `handle` and `displayName` claims; new `GET /handle/:handle` endpoint for availability checks; `verifyAccessToken` returns `handle` and `displayName`
- **`@osn/api`**: `createdByName` on events now uses `displayName` → `@handle` → email local-part (in that priority order)
- **`@osn/pulse`**: `getDisplayNameFromToken` updated to prefer `displayName` then `@handle`; new `getHandleFromToken` utility
