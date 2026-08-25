---
title: Session introspection + revocation
tags: [systems, auth, security]
related:
  - "[[identity-model]]"
  - "[[step-up]]"
  - "[[passkey-primary]]"
last-reviewed: 2026-08-24
---

# Session introspection + revocation

Per-device session management, exposed to users in Settings. Builds on the server-side session store introduced in Copenhagen Book C1/C2/C3.

## Refresh-token rotation chain (C2)

```mermaid
sequenceDiagram
  participant Client
  participant API as @osn/api /token
  participant DB as sessions table
  participant Store as RotatedSessionStore<br/>(Redis or in-memory)

  Client->>API: POST /token (refresh cookie)
  API->>DB: lookup hash(token)
  alt token unknown / expired
    API-->>Client: 401 (force re-auth)
  else token rotated previously (Store hit)
    alt replay within ROTATION_GRACE_MS (benign concurrency)
      API-->>Client: 401 (family PRESERVED — rotation_race)
    else replay outside grace (genuine reuse)
      API->>DB: DELETE WHERE family_id = ?
      API->>Store: revokeFamily(familyId)
      API-->>Client: 401 family_revoked
    end
  else token current
    API->>API: mint new session token (same family)
    API->>DB: insert new row, copy ua_label + ip_hash
    API->>Store: track(oldHash → familyId)
    API->>DB: DELETE old row
    API-->>Client: 200 + new HttpOnly cookie + access token
  end
```

### The session marker cookie (`osn_has_session`)

Every route that establishes or clears a session sets **two** cookies, via `buildSessionCookies` / `buildClearSessionCookies` in `osn/api/src/lib/cookie-session.ts`:

| Cookie | Flags | Holds |
|---|---|---|
| `__Host-osn_session` (`osn_session` locally) | HttpOnly, Secure, SameSite=Lax, Path=/, host-only | the opaque `ses_*` refresh token |
| `osn_has_session` | Secure, SameSite=Lax, Path=/, `Domain=` from `OSN_COOKIE_DOMAIN` | the single bit `1` |

The marker exists so the client can tell "never signed in" from "signed in, cookie not yet replayed" **without a request**. Before this, every cold page load with no stored account fired a bootstrap `POST /token`. A bot fleet loading a `*.pages.dev` copy of the app turned that into ~33k requests a day at the issuer — half the free-tier Worker budget — and rotating IPs defeated the per-IP limiters. `loadSession` now skips the grant when the marker is absent.

Design points worth keeping:

- **The server sets it, not the client.** It stays atomic with the cookie it describes, and it carries the right `Domain` — `id.musubi.social` issues, `musubi.social` reads, so a host-only marker would be invisible. The session cookie stays `__Host-` (a prefix forbids `Domain=`); the marker takes no prefix for the same reason.
- **It holds no secret.** A forged marker buys one 400. It is advisory only: no server-side decision may branch on it, and none does — the API reads it nowhere, it is write-only from the issuer's side.
- **The server retracts it only when the failure proves the cookie is dead** (S-M2). The `/token` 400 paths are not equal: no cookie sent at all retracts; a rejected grant retracts only if the rejection was a real verification failure. A `DatabaseError` and the benign concurrent-rotation race (`ROTATION_RACE_MESSAGE`, see PR #289) both arrive with a live cookie, and retracting on either would strand a cold-start browser — the exact population the marker serves — signed out until the user signs in by hand. The predicate is `sessionStatusUnknown` in `osn/api/src/lib/grant-failure.ts`; it fails *toward* retraction on anything unrecognised, and the response-header contract is pinned in `tests/routes/token-marker-retraction.test.ts`. The client can't delete the marker itself: from the apex it can't reproduce the `Domain` attribute, so a JS delete would only shadow it with a host-only cookie.
- **A rejected grant never clears the session cookie.** That branch also covers a storage blip; clearing would harden a transient failure into a permanent logout. A client that still holds local account state retries the grant without consulting the marker, which is the way back from a false negative.
- **No `document` ⇒ no gate.** iOS (Keychain transport) and SSR keep the old behaviour.
- **One-off migration cost:** a user holding a live cookie but no local account at deploy time is bounced to sign-in once, since no marker exists yet.

Local dev leaves `OSN_COOKIE_DOMAIN` unset — localhost is one host, so a host-only marker works. Dev sets `dev.musubi.social`, not the `musubi.social` parent: a marker set by the dev issuer must not reach production hosts. The value is validated against a bare-hostname pattern before it reaches the header (S-L2) and drops to host-only if it fails, so a bad var costs a cold-start sign-in rather than a spliced `Set-Cookie`.

**Standing constraint (S-L1):** the marker is readable by every host under `OSN_COOKIE_DOMAIN`. That is accepted — the bit is not a secret — but it means a `*.musubi.social` subdomain must never be delegated to a party that shouldn't learn whether a visitor holds an OSN session. Keep subdomain delegation in-house.

Per-account hard cap: `MAX_SESSIONS_PER_ACCOUNT = 50`. `issueTokens` LRU-evicts the oldest rows once the cap is reached so an attacker can't inflate the revocation surface. The public revocation handle (first 16 hex of the SHA-256) is collision-safe inside that bounded population.

## Endpoints

| Route | Purpose |
|---|---|
| `GET /sessions` | List the caller's active sessions with coarse UA labels + timestamps, flagging the current one |
| `DELETE /sessions/:id` | Revoke a session by its 16-hex public handle (first 16 chars of SHA-256 hash) |
| `POST /sessions/revoke-all-other` | Revoke every session EXCEPT the caller's current one |

All endpoints authenticate via `Authorization: Bearer <access_token>` and resolve `accountId` server-side. A session handle from account A's log cannot be replayed to revoke a session in account B — the DELETE is scoped to the caller's own account.

`GET /sessions` sets `Cache-Control: private, no-store` as the first statement of the handler, so even a rejection carries it (tracker#468). See `[[architecture/backend-patterns]]` §Cache-Control on Authenticated Routes for the rule and why it sits above the guards.

### Cross-device login

QR-code mediated session transfer — authenticate on a new device by scanning a code from an already-authenticated device.

| Route | Auth | Purpose |
|---|---|---|
| `POST /login/cross-device/begin` | None | Create a pending request; returns `requestId` + `cdlSecret` |
| `POST /login/cross-device/:requestId/status` | None | Poll for approval; returns session tokens once on approval |
| `POST /login/cross-device/:requestId/approve` | Bearer | Device A approves; issues session for device B |
| `POST /login/cross-device/:requestId/reject` | Bearer | Device A explicitly rejects |

**Protocol:** Device B calls `begin`, renders a QR code encoding the `requestId` + `cdlSecret`, and polls `status` at ~2s intervals. Device A scans the QR, calls `approve` with its access token + the secret from the QR fragment. The server issues a session for device B and records a `cross_device_login` security event + email notification.

**Security properties:** 256-bit CSPRNG secret, SHA-256 hashed at rest, constant-time comparison, one-time session consumption, 5-minute TTL, rate-limited on all endpoints. The secret never appears in URL query strings (all endpoints use POST bodies). In-memory store with FIFO eviction at 1000 entries — Redis migration deferred to Phase 4.

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

The server re-scans its sessions table by accountId and finds the row whose hash prefix matches. This maps handle → internal hash at request time.

## Access-token session binding (`osn_sid`)

Some endpoints must revoke every session on the account *except the caller's own* — passkey add (H1) and passkey delete (S-L3) both do. Until now the caller's own session was read only from the HttpOnly cookie. A request that authenticated with a Bearer access token but carried no cookie — a cross-origin call, a proxy that strips cookies, a native client — looked sessionless, so both paths took the "there is no self to preserve" branch and deleted **every** session on the account. Removing a passkey signed you out of every device, including the one you were on.

Access tokens now carry `osn_sid`: `sha256(session_hash + ":" + profile_id)` truncated to the first 32 hex chars (128 bits). Two properties matter:

- **One-way.** The session hash is itself a SHA-256 of a 160-bit random token, so `osn_sid` leaks nothing usable; a stolen `osn_sid` cannot be turned back into a session token.
- **Per-profile.** Sessions are account-scoped and shared across profile switches, so a plain session id in the token would let an observer tie two profiles of one account together — exactly what P6 forbids. Mixing the profile id in means each profile sees a different value for the same session.

Recognition is by recomputation: `resolveSessionByBinding(accountId, profileId, osn_sid)` reads the account's session rows — `ORDER BY last_used_at DESC LIMIT MAX_SESSIONS_PER_ACCOUNT` (50), so the caller's own row, recently used by definition, is inside the window even when a concurrent-login race leaves the account a row or two over the cap — derives the binding for each and returns the hash that matches, else `null`. The comparison is constant-time. No new secret, no schema change, no reverse lookup.

`issueTokens` and `refreshTokens` generate the session token before signing the JWT so the token binds to the session it ships with — on refresh, that is the rotated-**in** session, not the one being retired. `switchProfile` resolves the caller's session from the old profile's `osn_sid` and re-derives it for the new profile, so the binding survives a switch.

Routes never read the cookie and the binding themselves; they call `resolveCallerSession(accountId, profileId, { cookieSessionHash, sessionBinding })`. The cookie wins when it names a session that is still live, but **not merely by being present**: a revoked, expired or rotated-out cookie hashes to a value matching no row, and handing that to `invalidateOtherAccountSessions` would delete everything — the same sign-you-out-everywhere failure reached through a stale cookie instead of a missing one. The membership test is free, since the fallback already reads those rows.

With neither a live cookie nor a resolvable `osn_sid` there is genuinely no self to preserve, and the account-wide revocation stands — a token minted before this claim existed degrades to the old behaviour rather than failing.

## Rotation preserves metadata

Refresh-token rotation (Copenhagen Book C2) deletes the old session row and inserts a new one with a rotated session token. We copy the old row's `ua_label` and `ip_hash` onto the new row so Settings continues to show the same "Firefox on macOS" entry instead of flipping to a new device. The `last_used_at` timestamp is set to the rotation moment.

## Rotation grace window (concurrency tolerance)

Rotation is single-use, but legitimate clients produce concurrent or retried grants of the **same current token**: two browser tabs bootstrapping on reload, a cold-start bootstrap racing a 401-refresh in one tab, or a grant retried after a lost response. Treating every such replay as C2 reuse revoked the whole family and logged the user out across every device — the "logs out sometimes" bug. Two guards now distinguish benign concurrency from genuine reuse, WITHOUT weakening detection of a real replay:

- **CAS-0-rows is always benign.** In the rotation swap the old-session `DELETE` is a compare-and-swap; a 0-rows result means the row was present at verify but gone by delete — i.e. a concurrent grant rotated it in the gap. A replay of an *already*-rotated token can't reach here (it fails `verifyRefreshToken`, whose row is absent, and goes down `detectReuse`). So a 0-rows CAS is never reuse: the losing grant fails but the family is **preserved** (no `revokeFamily`, no `reuse_detected`; a `rotation_race` metric fires instead).
- **`detectReuse` grace window.** When a rotated-out hash is replayed, `detectReuse` compares `now − rotatedAtMs` against `ROTATION_GRACE_MS` (10 s). Within the window it is benign concurrency/retry → family preserved (`rotation_race`). Outside it → genuine reuse → full family revocation (unchanged). The window is short: an attacker replaying a stolen rotated token seconds after the legitimate rotation gains nothing they couldn't do with the live token, and any replay after the window still revokes. Mirrors the "reuse leeway" interval standard in rotating-refresh-token implementations.

**Reading the CAS result.** The rows-affected field differs per driver — bun:sqlite gives `{ changes }`, libsql `{ rowsAffected }`, and Cloudflare D1 `{ success, meta: { changes } }`. The CAS reads it through `rowsChanged` in `@shared/db-utils`, which knows all three. This is not a detail: the gate once read only the top-level fields, which is correct on the bun:sqlite the tests run against and always `undefined` on the D1 production runs. Every production refresh therefore deleted its session, skipped the replacement INSERT, and answered `400 invalid_grant` — sessions died at the first refresh after five minutes, and no prod session row ever had `last_used_at` move past `created_at`. Any new rows-affected check must go through the same helper.

The client complements this with a shared single-flight (`osn/client`): the bootstrap and refresh paths dedupe the `/token` grant against each other so a bootstrap racing a refresh in one tab fires `/token` once. Cross-*tab* coordination (a Web Locks guard) is a possible follow-up; the server grace already prevents cross-tab races from revoking the family.

## Cluster-safe reuse detection (S-H1 session)

The C2 reuse detector needs to remember, for up to `refreshTokenTtl` (30 days), which session hashes have been rotated out. Originally this lived as an in-process `Map<hash, { familyId, rotatedAt }>` inside `createAuthService` — correct for single-process dev but silently partitioned in multi-pod deployments: a rotation recorded on pod A was invisible to pod B, so replays hitting B passed without triggering family revocation.

The `RotatedSessionStore` abstraction (`osn/api/src/lib/rotated-session-store.ts`) replaces that map. `createInMemoryRotatedSessionStore()` preserves the FIFO-swept, `ROTATED_SESSIONS_MAX = 100_000`-bounded in-process behaviour for tests and single-process dev. `createRedisRotatedSessionStore(client)` backs the state on Redis using one key family:

- `osn:rot-session:hash:{sessionHash}` → `{familyId}:{rotatedAtMs}`, PX = `refreshTokenTtl * 1000` — the authoritative lookup used by `check`. `check` returns `{ familyId, rotatedAtMs }` (a `RotatedHashRecord`); the rotation timestamp drives the grace-window classification below. A legacy value with no numeric suffix parses to `rotatedAtMs 0` (rotated "long ago" → treated as genuine reuse — the strict default).

Redis's native per-key PX expiry handles cleanup, so `track` is a single round-trip (no family-set write, no JSON blob, no cross-command race). `revokeFamily` is a deliberate no-op on the Redis backend — the DB-level `DELETE FROM sessions WHERE family_id = ?` in `detectReuse` is the authoritative revocation. A stale `hash:*` key that lingers until TTL only means a later replay fires another idempotent DB delete plus another `reuse_detected` metric increment. That is a more useful observability signal than silently deduping the attempt.

Failure modes fail **open**: `check` returns `null` on Redis error (so an outage cannot manufacture false-positive family revocations that log legitimate users out), and `track` logs a warning and continues (the DB-level rotation has already committed). The trade-off is a temporary weakening of reuse detection during a Redis outage, not a loss of session security — the DB row lookup in `verifyRefreshToken` is still authoritative for rejecting unknown tokens. The store wraps the `onError` callback from `index.ts` in its own try/swallow, so a misconfigured observability layer cannot cascade into a rejected store operation. `sanitizeCause` strips any embedded credentialed URLs from ioredis connection error strings before they are annotated.

`AuthConfig.rotatedSessionStore` is the injection point. Non-local deploys pass the Redis-backed store from `osn/api/src/index.ts`; tests and the in-memory fallback path omit it.

## Observability

- `osn.auth.session.operations{action, result}` — one per `list` / `revoke` / `revoke_all` call
- Spans: `auth.session.list`, `auth.session.revoke`, `auth.session.revoke_all`, `auth.session.resolve_binding` (the `osn_sid` lookup), `auth.session.resolve_caller` (cookie-or-binding "who is calling")
- `SecurityInvalidationTrigger` union extended with `session_revoke`, `session_revoke_all`, and `passkey_delete` so the H1 dashboard picks up user-initiated revocations alongside passkey-register, passkey-delete, recovery-code, and email-change triggers
- `osn.auth.session.rotated_store.operations{action, result, backend}` — counter for every rotated-session store call. `action` ∈ `track` / `check` / `revoke_family`; `result` ∈ `ok` / `hit` / `miss` / `error`; `backend` ∈ `memory` / `redis`. Error rate by backend is the primary Redis-health signal for the reuse detector.
- `osn.auth.session.reuse_detected` / `osn.auth.session.family_revoked` — genuine C2 reuse caught (replay outside the grace window) and the resulting whole-family revocations. A spike is a real security signal (token theft) — distinct from the benign metric below.
- `osn.auth.session.rotation_race` — benign concurrent/retried grants tolerated within `ROTATION_GRACE_MS` (CAS-0-rows or a rotated-token replay inside the window). The family is PRESERVED. Expected to be non-zero for normal multi-tab usage; it is NOT a security signal. Watch the ratio of `family_revoked` to `rotation_race` — a rise in the former relative to the latter is what matters.
- `osn.auth.session.rotated_store.duration{action, backend}` — histogram of store operation latency
- Spans: `auth.session.rotated_store.track`, `auth.session.rotated_store.check`, `auth.session.rotated_store.revoke_family`, wrapped by the outer `auth.session.reuse_detect` and `auth.session.rotate` spans
- Redaction: `ipHash`, `uaLabel` (both spellings), `familyId` (already in the deny-list — correlates sessions across rotation events)

## UI

- `@osn/ui/auth/SessionsView` — Settings panel. "This device" badge on current, Revoke button disabled for current, "Sign out everywhere else" with a synchronous `confirm()` (toast-style undo would leave the stolen-session window open).

**Device / passkey management (#155).** The companion `@osn/ui/auth/PasskeysView` surfaces the *credential* side of device management — list / add / rename / remove passkeys, each destructive operation step-up-gated. It mounts in `@osn/social`'s Settings Security section and, as of #155, in the cire organiser portal's `SecurityPanel`. Because the deployed osn-api runs with email degraded ([[email]]), cire mounts it with `StepUpDialog`'s `passkeyOnly` flag so the OTP step-up factor is suppressed (an OTP that can't be mailed would dead-end the ceremony). New-device help (a backed-up/synced passkey, the cross-device QR ceremony above, or a recovery code) is covered on [[passkey-primary]].

## Threat model

Gives the user a fast lever to react to:

- Lost / stolen device → `Revoke` that specific session.
- Suspected compromise → `Sign out everywhere else` from a known-good device.
- Routine hygiene → surface all devices currently holding a valid cookie.

With 5-min access tokens and rotation-on-refresh, the attacker's window after revocation is under 5 minutes.
