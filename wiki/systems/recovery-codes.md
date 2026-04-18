---
title: Recovery Codes (Copenhagen Book M2)
tags: [identity, auth, recovery, security]
related:
  - "[[identity-model]]"
  - "[[rate-limiting]]"
packages:
  - "@shared/crypto"
  - "@osn/db"
  - "@osn/api"
  - "@osn/client"
  - "@osn/ui"
last-reviewed: 2026-04-18
updated: 2026-04-18
---

# Recovery Codes

Copenhagen Book **M2** — single-use, high-entropy, account-scoped recovery tokens. They're the escape hatch when a user loses every device enrolled with a passkey. Landing this unblocks the next phase ([[identity-model]] — passkey-primary login).

## Shape

- Each code: 16 lowercase hex chars, displayed as `xxxx-xxxx-xxxx-xxxx`.
- Entropy: 64 bits per code (uniformly random via `crypto.randomBytes`).
- Batch size: **10 codes** per generation (`RECOVERY_CODE_COUNT`).
- Storage: only `SHA-256(normalised code)` lives in the DB. Raw codes are returned **once** at generation time, never retrievable again.

Normalisation strips whitespace and ASCII separators before hashing, and lowercases — a user typing `ABCD-1234-5678-EF00` or `abcd 1234 5678 ef00` both match the same stored hash.

## Schema

```
recovery_codes
  id            text PK            "rec_" + 12 hex
  account_id    text FK → accounts.id
  code_hash     text UNIQUE        hex of SHA-256(normalised code)
  used_at       integer NULL       unix seconds; non-null = consumed
  created_at    integer            unix seconds
```

Migration: `osn/db/drizzle/0004_add_recovery_codes.sql`.

## API

```
POST /recovery/generate
  Authorization: Bearer <access_token>
  Body: {}
  → 200 { recoveryCodes: [ "xxxx-xxxx-xxxx-xxxx", ... × 10 ] }
  Rate limited: 1/day/IP (recoveryGenerate) — stop-gap for S-M1
```

Wire field is `recoveryCodes` (not `codes`) so the redaction deny-list entry matches (S-L2). Emits `osn.auth.session.security_invalidation{trigger="recovery_code_generate"}` on every successful generate so out-of-band regeneration is visible in the existing session-invalidation dashboard.

Regenerating atomically replaces any previous set — the transaction deletes the existing rows and inserts the new ones. The previous codes become permanently invalid.

```
POST /login/recovery/complete
  Body: { identifier: "<handle-or-email>", code: "xxxx-..." }
  → 200 { session: TokenResponse, profile: PublicProfile }
  Rate limited: 5/hour/IP (recoveryComplete)
```

On success the server:
1. Marks the consumed row's `used_at` — the row is kept for audit.
2. **Revokes every session on the account** in the same transaction. The fresh session issued by the login step is the only one standing afterwards. Emits `osn.auth.session.security_invalidation{trigger="recovery_code_consume"}`.
3. Sets the HttpOnly session cookie (C3) and returns the access token in the body.

All failure modes — unknown identifier, bad code, used code — surface as `{ error: "invalid_request" }` with no distinguishing detail, preserving the no-enumeration posture from `/login/otp`. Both the known-identifier + wrong-code branch and the unknown-identifier branch execute the same set of DB + SHA-256 work so latency does not disclose user existence (S-M2).

## Service layer

`createAuthService` exposes:

- `generateRecoveryCodesForAccount(accountId) → { codes: string[] }` — transactional replace + insert.
- `consumeRecoveryCode(identifier, code) → { profile }` — verify, mark used, revoke sessions, return profile.
- `completeRecoveryLogin(identifier, code) → { session, profile }` — `consumeRecoveryCode` + `issueTokens`, wrapped with the standard `withAuthLogin("recovery_code")` metric span.
- `countActiveRecoveryCodes(accountId)` — helpers for a "codes remaining" UI badge.

## Client

`createRecoveryClient({ issuerUrl })` in `@osn/client`:

```ts
await client.generateRecoveryCodes({ accessToken });  // → { codes }
await client.loginWithRecoveryCode({ identifier, code });  // → { session, profile }
```

UI: `RecoveryCodesView` (settings panel, show-once with copy + download) and `RecoveryLoginForm` (sign-in recovery modal).

## Observability

| Metric | Attrs | Emitted |
|---|---|---|
| `osn.auth.recovery.codes_generated` | none | Every successful generate |
| `osn.auth.recovery.code_consumed` | `result: success \| invalid \| used` | Every consume attempt |
| `osn.auth.recovery.duration` | `step: generate \| consume, result: ok \| error` | Histogram, per step |
| `osn.auth.login.*` | `method: recovery_code` | Inherited from the normal login wrapper on `completeRecoveryLogin` |

Spans: `auth.recovery.generate`, `auth.recovery.consume`, `auth.login.recovery_code`.

Redaction deny-list adds `recoveryCode`, `recovery_code`, `recoveryCodes`, `recovery_codes`, `codeHash`, `code_hash` — see `shared/observability/src/logger/redact.ts`.

## Threat model

- **Target risk:** an adversary with a leaked DB tries to brute-force a user's code. Per-user search space is 10 codes × 2^64 / 2^64 ≈ 2^64 operations on average to hit any code — infeasible. SHA-256 is fine: the tokens are uniformly random high-entropy secrets, not password-derived.
- **Online brute force** against one account is bounded by the IP rate limit (5/hr) + the 10-code × 2^64 search space. Effectively zero.
- **Leaked code at rest** (screenshot, shared notes): single-use, and regenerating invalidates it. The user's footgun surface is "I saved them badly"; the UI requires an explicit "I've saved these" checkbox before it will dismiss the one-time view.
- **No enumeration oracle** — every failure returns the same payload.

## When to regenerate

- After consuming one: the remaining 9 are still valid; no forced regen, but the UI should nudge at ≤3 active.
- After adding or removing a passkey: no-op (the codes are orthogonal to passkeys).
- Whenever the user suspects the codes leaked.
