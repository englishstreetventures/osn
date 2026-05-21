---
"@pulse/app": minor
"@pulse/api": minor
"@pulse/db": minor
"@osn/api": minor
---

Pulse first-run onboarding: six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Captures interests, location/notifications permissions, and reminder opt-in. Account-keyed server-side via a new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + new `GET /graph/internal/profile-account` ARC endpoint on `osn/api` — preserves the multi-account privacy invariant (accountId never on the wire). Server-side first-run gate redirects new users to `/welcome` and is idempotent on the completion POST. See `wiki/systems/pulse-onboarding.md`.
