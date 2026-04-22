---
title: Session introspection + revocation
tags: [systems, auth, security]
related:
  - identity-model
  - step-up
last-reviewed: 2026-04-22
---

# Session introspection + revocation

Per-device session management surface exposed to end users in Settings. Builds on the server-side session store introduced in Copenhagen Book C1/C2/C3.

Per-account hard cap: `MAX_SESSIONS_PER_ACCOUNT = 50`. `issueTokens` LRU-evicts the oldest rows once the cap is reached so an attacker can't inflate the revocation surface. The public revocation handle (first 16 hex of the SHA-256) is collision-safe inside that bounded population.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /sessions` | List the caller's active sessions with coarse UA labels + timestamps, flagging the current one |
| `DELETE /sessions/:id` | Revoke a session by its 16-hex public handle (first 16 chars of SHA-256 hash) |
| `POST /sessions/revoke-all-other` | Revoke every session EXCEPT the caller's current one |

All endpoints authenticate via `Authorization: Bearer <access_token>` and resolve `accountId` server-side. A session handle from account A's log cannot be replayed to revoke a session in account B — the DELETE is scoped to the caller's own account.

## Metadata captured at issue time

Added to the `sessions` table in migration `0005_sessions_metadata_and_email_change.sql`:

| Column | What it stores | Source |
|---|---|---|
| `ua_label` | Coarse `"Firefox on macOS"` label | `deriveUaLabel(headers["user-agent"])` — bounded cardinality |
| `ip_hash` | `HMAC-SHA256(sessionIpPepper, ip)` | `getClientIp()` + peppered HMAC |
| `last_used_at` | Unix seconds | Updated on every successful refresh/verify |

**Why HMAC-peppered, not raw SHA-256 for IPs?** Plain SHA-256 over the v4 address space (2^32) is trivially rainbow-tableable. A server-side secret pepper makes offline correlation impossible without pepper access. Pepper rotation is cheap — only display continuity is affected, not session validity.

**Configuration:** `OSN_SESSION_IP_PEPPER` (≥32 bytes). Startup fails in non-local environments if unset — silent IP-hash degradation would cost users a security signal without anyone noticing.

## Public revocation handle

The public `id` field is the first 16 hex chars of the session-token SHA-256. Chosen over exposing the full hash because:

- **64 bits of collision resistance** is more than enough inside a single account's handful of sessions.
- A full SHA-256 accidentally logged gives an attacker a forge-able DELETE URL. A 16-hex prefix does not.

The server re-scans its sessions table by accountId and finds the row whose hash prefix matches, mapping handle → internal hash at request time.

## Rotation preserves metadata

Refresh-token rotation (Copenhagen Book C2) deletes the old session row and inserts a new one with a rotated session token. We copy the old row's `ua_label` and `ip_hash` onto the new row so Settings continues to show the same "Firefox on macOS" entry instead of flipping to a new device. The `last_used_at` timestamp is set to the rotation moment.

## Cluster-safe reuse detection (S-H1 session)

The C2 reuse detector needs to remember, for up to `refreshTokenTtl` (30 days), which session hashes have been rotated out. Originally this lived as an in-process `Map<hash, { familyId, rotatedAt }>` inside `createAuthService` — correct for single-process dev but silently partitioned in multi-pod deployments: a rotation recorded on pod A was invisible to pod B, so replays hitting B passed without triggering family revocation.

The `RotatedSessionStore` abstraction (`osn/api/src/lib/rotated-session-store.ts`) replaces that map. `createInMemoryRotatedSessionStore()` preserves the FIFO-swept, `ROTATED_SESSIONS_MAX = 100_000`-bounded in-process behaviour for tests and single-process dev. `createRedisRotatedSessionStore(client)` backs the state on Redis using one key family:

- `osn:rot-session:hash:{sessionHash}` → `familyId`, PX = `refreshTokenTtl * 1000` — the authoritative lookup used by `check`.

Cleanup is delegated to Redis's native per-key PX expiry, so `track` is a single round-trip (no family-set write, no JSON blob, no cross-command race). `revokeFamily` is a deliberate no-op on the Redis backend — the DB-level `DELETE FROM sessions WHERE family_id = ?` in `detectReuse` is the authoritative revocation, and a stale `hash:*` key lingering until TTL just means a subsequent replay fires another idempotent DB delete plus another `reuse_detected` metric increment, which is a more informative observability signal than silently deduping the attempt.

Failure modes fail **open**: `check` returns `null` on Redis error (so an outage cannot manufacture false-positive family revocations that log legitimate users out), and `track` logs a warning and continues (the DB-level rotation has already committed). The trade-off is a temporary weakening of reuse detection during a Redis outage, not a loss of session security — the DB row lookup in `verifyRefreshToken` is still authoritative for rejecting unknown tokens. The `onError` callback passed by `index.ts` is itself wrapped in a try/swallow inside the store, so a misconfigured observability layer cannot cascade into a rejected store operation. Connection-level error strings from ioredis are routed through `sanitizeCause` before annotation to strip any credentialed URLs that may be embedded in the cause.

`AuthConfig.rotatedSessionStore` is the injection point. Non-local deploys pass the Redis-backed store from `osn/api/src/index.ts`; tests and the in-memory fallback path omit it.

## Observability

- `osn.auth.session.operations{action, result}` — one per `list` / `revoke` / `revoke_all` call
- Spans: `auth.session.list`, `auth.session.revoke`, `auth.session.revoke_all`
- `SecurityInvalidationTrigger` union extended with `session_revoke` and `session_revoke_all` so the H1 dashboard picks up user-initiated revocations alongside passkey-register, recovery-code, and email-change triggers
- `osn.auth.session.rotated_store.operations{action, result, backend}` — counter for every rotated-session store call. `action` ∈ `track` / `check` / `revoke_family`; `result` ∈ `ok` / `hit` / `miss` / `error`; `backend` ∈ `memory` / `redis`. Error rate by backend is the primary Redis-health signal for the reuse detector.
- `osn.auth.session.rotated_store.duration{action, backend}` — histogram of store operation latency
- Spans: `auth.session.rotated_store.track`, `auth.session.rotated_store.check`, `auth.session.rotated_store.revoke_family`, wrapped by the outer `auth.session.reuse_detect` and `auth.session.rotate` spans
- Redaction: `ipHash`, `uaLabel` (both spellings), `familyId` (already in the deny-list — correlates sessions across rotation events)

## UI

- `@osn/ui/auth/SessionsView` — Settings panel. "This device" badge on current, Revoke button disabled for current, "Sign out everywhere else" with a synchronous `confirm()` (toast-style undo would leave the stolen-session window open).

## Threat model

Gives the user a fast lever to react to:

- Lost / stolen device → `Revoke` that specific session.
- Suspected compromise → `Sign out everywhere else` from a known-good device.
- Routine hygiene → surface all devices currently holding a valid cookie.

Combined with 5-min access tokens and rotation-on-refresh, the effective attacker window post-revocation is <5 min.
