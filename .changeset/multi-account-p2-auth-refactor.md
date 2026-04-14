---
"@osn/core": minor
"@shared/observability": patch
---

Multi-account P2: two-tier token model and profile switching

Refresh tokens are now scoped to accounts (sub=accountId), access tokens remain scoped to profiles (sub=profileId). This enables profile switching without re-authentication.

New endpoints:
- `POST /profiles/switch` — switch to a different profile under the same account
- `GET /profiles` — list all profiles for the authenticated account

New service functions: `switchProfile`, `listAccountProfiles`, `verifyRefreshToken`, `findDefaultProfile`.

New metric: `osn.auth.profile_switch.attempts` with bounded `ProfileSwitchAction` attribute union.

Breaking: existing refresh tokens (profile-scoped) will fail on refresh — users must re-authenticate once.
