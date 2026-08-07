---
title: Recovery Codes (Copenhagen Book M2)
tags: [identity, auth, recovery, security]
related:
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[rate-limiting]]"
  - "[[step-up]]"
packages:
  - "@shared/crypto"
  - "@osn/db"
  - "@osn/api"
  - "@osn/client"
  - "@osn/ui"
last-reviewed: 2026-08-07
updated: 2026-06-16
---

# Recovery Codes

Copenhagen Book **M2** — single-use, high-entropy, account-scoped recovery tokens. They're the "my device is gone" escape hatch in the passkey-primary model (`[[passkey-primary]]`). They are **not** a substitute credential: `deletePasskey` refuses to drop the account below 1 passkey regardless of recovery-code state.

## Shape

- Each code: 16 lowercase hex chars, displayed as `xxxx-xxxx-xxxx-xxxx`.
- Entropy: 64 bits per code (uniformly random via `crypto.randomBytes`).
- Batch size: **10 codes** per generation (`RECOVERY_CODE_COUNT`).
- Storage: only `SHA-256(normalised code)` lives in the DB. Raw codes are returned **once** at generation time, never retrievable again.

Normalisation strips whitespace and ASCII separators before hashing, and lowercases — so `ABCD-1234-5678-EF00` and `abcd 1234 5678 ef00` both match the same stored hash.

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
  Body: { step_up_token: "<jwt>" }   (or the x-step-up-token header)
  → 200 { recoveryCodes: [ "xxxx-xxxx-xxxx-xxxx", ... × 10 ] }
  → 403 { error: "step_up_required" }  when the token is missing or stale
  Rate limited: 10/hour/IP (recoveryGenerate)
```

Step-up gated (M-PK1): a stolen access token on its own must not be able to burn the account's codes. Run the ceremony first (`[[step-up]]`) and pass the token it mints. Allowed factors default to `["webauthn", "otp"]`.

**Purpose-bound (S-M1).** The token must carry `purpose: "recovery_generate"`. Generating destroys the whole existing set, so a token minted for another ceremony — an email change, a passkey delete — must not be replayable here. Callers pass `purpose` to `/step-up/passkey/complete` or `/step-up/otp/complete`; a purposeless token is refused with `step_up_required`. See `[[step-up]]`.

Wire field is `recoveryCodes` (not `codes`) so the redaction deny-list entry matches (S-L2). Emits `osn.auth.session.security_invalidation{trigger="recovery_code_generate"}` on every successful generate so out-of-band regeneration is visible in the existing session-invalidation dashboard.

Regenerating atomically replaces any previous set — the transaction deletes the existing rows and inserts the new ones. The previous codes become permanently invalid.

```
GET /recovery/status
  Authorization: Bearer <access_token>
  → 200 { active: 7, total: 10, generatedAt: 1750000000 }
  → 200 { active: 0, total: 0, generatedAt: null }   account has never generated
  Rate limited: 30/min/IP (recoveryStatus)
```

**No step-up.** The response carries counts only, never a code, and gating it would be circular — this answer is what tells a user whether starting a ceremony is worth it. It is still account-scoped, so an anonymous read returns 401. `generatedAt` is `max(created_at)` over the set (unix seconds); generation replaces the whole set atomically, so the newest row dates the set as a whole.

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

All failure modes — unknown identifier, bad code, used code — surface as `{ error: "invalid_request" }` with no distinguishing detail. Both the known-identifier + wrong-code branch and the unknown-identifier branch run the same DB + SHA-256 work, so latency does not reveal whether the user exists (S-M2). Recovery login is the "lost device" escape hatch; see `[[passkey-primary]]` for the broader login model.

## Service layer

`createAuthService` exposes:

- `generateRecoveryCodesForAccount(accountId, eventMeta?) → { recoveryCodes: string[] }` — transactional replace + insert. The optional `eventMeta` (UA label + IP) is persisted on the paired `security_events` audit row (see **Regeneration notification** below).
- `consumeRecoveryCode(identifier, code) → { profile }` — verify, mark used, revoke sessions, return profile.
- `completeRecoveryLogin(identifier, code) → { session, profile }` — `consumeRecoveryCode` + `issueTokens`, wrapped with the standard `withAuthLogin("recovery_code")` metric span.
- `countActiveRecoveryCodes(accountId) → { active, total, generatedAt }` — one SQL aggregate (P-I1), never SELECTs the secret-bearing `code_hash`. Backs `GET /recovery/status`.
- `listUnacknowledgedSecurityEvents(accountId) → { events }` — drives the Settings banner.
- `acknowledgeSecurityEvent(accountId, id) → { acknowledged }` — idempotent, scoped to the owning account.

## Regeneration + consumption notification (M-PK1b)

Step-up gates `/recovery/generate`, but a compromised session with inbox access could still mint a step-up token and burn the user's codes; the actual takeover step is `/login/recovery/complete`. The audit trail is the final defence on both halves:

1. **Audit row — generate.** Every `generateRecoveryCodesForAccount` call inserts a `security_events` row (kind `"recovery_code_generate"`) in the same transaction as the code swap. If the audit write fails, the codes don't commit either.
2. **Audit row — consume (S-H1).** Every successful `consumeRecoveryCode` inserts a `security_events` row (kind `"recovery_code_consume"`) in the same transaction as the sessions wipe. Failed consume attempts (wrong code, unknown identifier) do NOT record — only genuine takeovers.
3. **Email notification.** Both kinds fire a best-effort email (S-L5 framed, codes never included). Dispatch runs under `Effect.forkDaemon` with a 10 s `Effect.timeout`, so mailer health does not affect user-visible request latency (P-W2). Failure is reported via `osn.auth.security_event.notified{result=failed}` and never rolls back the primary action.
4. **Settings banner.** `GET /account/security-events` surfaces still-unacknowledged rows (newest first, `limit 50`, backed by a partial index over `WHERE acknowledged_at IS NULL` — P-W1). Dismissal happens via `POST /account/security-events/:id/ack` or the bulk `POST /account/security-events/ack-all`, **both gated by a fresh step-up token (S-M1)** — an XSS-captured access token cannot silently clear the banner, because the banner exists to warn about that compromise. Ack is idempotent; ack-all returns the number of rows dismissed. UI in `@osn/ui/auth/SecurityEventsBanner` (opens `StepUpDialog` on "Acknowledge", then POSTs to `ack-all`); SDK in `@osn/client/security-events.ts`.

Schema lives in `osn/db/src/schema/index.ts` → `securityEvents`. Columns: `id` (`sev_` + 12 hex), `account_id`, `kind` (bounded string literal enforced at service boundary, not the column), `created_at`, `acknowledged_at`, `ip_hash`, `ua_label`. Index: `security_events_unacked_idx (account_id, created_at) WHERE acknowledged_at IS NULL`.

Migration: `osn/db/drizzle/0006_security_events.sql`.

## Client

`createRecoveryClient({ issuerUrl })` in `@osn/client`:

```ts
await client.generateRecoveryCodes({ accessToken, stepUpToken });  // → { codes }
await client.getRecoveryCodesStatus({ accessToken });  // → { active, total, generatedAt }
await client.loginWithRecoveryCode({ identifier, code });  // → { session, profile }
```

`stepUpToken` is optional in the type only so the call compiles in hosts that thread it separately; omit it and the server answers 403.

## UI

`RecoveryCodesView` (`@osn/ui/auth/RecoveryCodesView`) is the settings surface. It:

- reads `GET /recovery/status` on mount, and again once the user dismisses a fresh set, and says outright when the account has **no** codes — the failure mode this view exists to catch is a user who never made any;
- runs the step-up ceremony through `StepUpDialog` before generating, with `purpose="recovery_generate"`, and passes the minted token straight to generate;
- confirms before rotating an existing set (the previous codes die immediately), and treats an **unreadable** count as "might have codes" so a failed status read never skips the warning (S-L1);
- holds the generate button until the first status read settles — before that the view cannot tell a first set from a rotation — and **says so while it waits** (2026-07-30): a pulse skeleton reserves the status line's height so nothing shifts when the count lands, and the button reads "Checking…". Held-and-silent read as broken on a slow link, which is the opposite of what a panel about account recovery wants to convey;
- shows the codes once with copy + `.txt` download, and gates the Done button on an explicit "I've saved these" checkbox;
- fails soft on a status read error — the count goes unknown, generation still works.

Props: `client`, `stepUpClient`, `accessToken`, plus optional `runPasskeyCeremony` (kept caller-side so `@osn/ui` doesn't depend on `@simplewebauthn/browser`), `passkeyOnly`, `onSaved`.

Mounted in:

- `osn/social/src/components/SecuritySection.tsx` — Settings → Security, under the passkey list.
- `cire/host/src/components/SecurityPanel.tsx` — same position, `passkeyOnly` forced (that deployment's OTP factor can't be relied on).

`RecoveryLoginForm` is the redemption side, mounted in `@osn/ui/auth/SignIn`.

## Observability

| Metric | Attrs | Emitted |
|---|---|---|
| `osn.auth.recovery.codes_generated` | none | Every successful generate |
| `osn.auth.recovery.code_consumed` | `result: success \| invalid \| used` | Every consume attempt |
| `osn.auth.recovery.duration` | `step: generate \| consume, result: ok \| error` | Histogram, per step |
| `osn.auth.login.*` | `method: recovery_code` | Inherited from the normal login wrapper on `completeRecoveryLogin` |
| `osn.auth.security_event.recorded` | `kind: recovery_code_generate` | Every audit-row insert |
| `osn.auth.security_event.notified` | `kind, result: sent \| failed \| skipped` | Every email dispatch attempt |
| `osn.auth.security_event.acknowledged` | `kind` | Every successful ack |
| `osn.auth.security_event.notify.duration` | `result: ok \| error` | Histogram, per dispatch |

Spans: `auth.recovery.generate`, `auth.recovery.consume`, `auth.login.recovery_code`, `auth.security_event.{list,ack,notify_recovery_regeneration}`.

Redaction deny-list adds `recoveryCode`, `recovery_code`, `recoveryCodes`, `recovery_codes`, `codeHash`, `code_hash`, `securityEventId`, `security_event_id` — see `shared/observability/src/logger/redact.ts`.

## Per-account lockout (O2)

`consumeRecoveryCode` adds a per-account failed-attempt ceiling on top of the per-IP rate limit. The counter is keyed on the **resolved `accountId`**, never the caller-supplied identifier — keying on the identifier would let an attacker lock a victim out by spamming their handle (DoS) and would also leak existence ("this identifier can be locked, therefore it exists"). An unknown identifier resolves to no account and so can never move a counter.

- **Threshold / window:** 5 failed attempts → 15-minute lockout (`RECOVERY_LOCKOUT_THRESHOLD` / `RECOVERY_LOCKOUT_MS` in `osn/api/src/lib/recovery-lockout-store.ts`).
- **Both "wrong code" and "already-used code" count** as failures.
- **On lockout** the consume still runs the same indexed SELECT for latency parity and returns the **same generic `Invalid request`** error — a locked account is indistinguishable from a wrong code (no enumeration oracle).
- **Audit + reset:** crossing the threshold writes a `recovery_code_lockout` security-event row (surfaced in the in-app banner) and emits `osn.auth.recovery.lockout{result}`. A successful consume resets the counter.
- **Store:** injectable triple-pattern (interface → in-memory default → `createRedisRecoveryLockoutStore` for multi-pod, atomic `INCR`+`PEXPIRE`). **Fail-open** on Redis outage — an unavailable counter must not lock every account out; the per-IP limit and the 2^64 search space remain in force. See `[[redis]]`.

## Threat model

- **Target risk:** an adversary with a leaked DB tries to brute-force a user's code. Per-user search space is 10 codes × 2^64 / 2^64 ≈ 2^64 operations on average to hit any code — infeasible. SHA-256 is fine: the tokens are uniformly random high-entropy secrets, not password-derived.
- **Online brute force** against one account is bounded by the IP rate limit (5/hr), the **per-account lockout (O2)**, and the 10-code × 2^64 search space. Effectively zero.
- **Leaked code at rest** (screenshot, shared notes): single-use, and regenerating invalidates it. The remaining risk is "I saved them badly"; the UI requires an explicit "I've saved these" checkbox before it will dismiss the one-time view.
- **No enumeration oracle** — every failure returns the same payload.

## When to regenerate

- After consuming one: the remaining 9 stay valid; no forced regeneration, but the UI should prompt at ≤3 active.
- After adding or removing a passkey: no-op (the codes are orthogonal to passkeys).
- Whenever the user suspects the codes leaked.
