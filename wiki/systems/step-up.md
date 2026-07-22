---
title: Step-up (sudo) tokens
tags: [systems, auth, security]
related:
  - "[[identity-model]]"
  - "[[recovery-codes]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
last-reviewed: 2026-07-22
---

# Step-up (sudo) tokens

The most sensitive endpoints require short-lived, high-assurance tokens. A stolen access token on its own then cannot reach destructive actions (recovery-code generation, email change).

## When step-up is required

| Endpoint | Required amr |
|---|---|
| `POST /recovery/generate` | `webauthn` or `otp` (configurable via `recoveryGenerateAllowedAmr`) |
| `POST /account/email/complete` | `webauthn` or `otp` |
| `PATCH /passkeys/:id` (rename) | `webauthn` only by default — uses `passkeyDeleteAllowedAmr` (S-M2) |
| `DELETE /passkeys/:id` | `webauthn` only by default — `passkeyDeleteAllowedAmr` knob, defaults to `["webauthn"]` (S-L4) |
| `POST /account/security-events/:id/ack` + `/ack-all` | `webauthn` or `otp` |

The caller presents the token either as an `X-Step-Up-Token` header or a `step_up_token` body field (email change uses body-only).

## Ceremony

Two factors, both authenticated via the caller's existing Bearer access token:

| Route | Purpose |
|---|---|
| `POST /step-up/passkey/begin` | WebAuthn assertion options, scoped to the caller's account |
| `POST /step-up/passkey/complete` | Verifies signed assertion, returns `{ step_up_token, expires_in }` |
| `POST /step-up/otp/begin` | Sends a 6-digit OTP to the account's verified email |
| `POST /step-up/otp/complete` | Verifies code, returns `{ step_up_token, expires_in }` |

Step-up OTPs are keyed separately from login OTPs — a login code cannot authorise a sensitive action, and a step-up code cannot complete a login.

## Token shape

ES256 JWT signed with the same key as access tokens (reuses `/.well-known/jwks.json`). Claims:

```json
{
  "sub": "acc_<accountId>",
  "aud": "osn-step-up",
  "iss": "<AuthConfig.issuerUrl>",
  "amr": ["webauthn"],
  "jti": "<uuid>",
  "iat": 1776988800,
  "exp": 1776989100
}
```

- **aud** — fixed literal `"osn-step-up"` so the token cannot be cross-used as an access token.
- **iss** — (O1) pinned to `AuthConfig.issuerUrl`; the verifier rejects any other issuer. Every verify also allows a **30s `clockTolerance`** for benign signer/verifier skew. Both access and step-up tokens share this contract.
- **sub** — `accountId` (not profileId). The verifier requires a match against the caller's resolved account.
- **amr** — RFC 8176 authentication-method-reference array. Verifier intersects with a caller-supplied allow-list.
- **jti** — single-use replay guard. Backed by a `StepUpJtiStore` interface (see `osn/api/src/services/auth/stores.ts`) with two implementations: an in-memory Map for single-process dev/test, and `createRedisJtiStore` (`osn/api/src/lib/step-up-jti-store.ts`) for multi-pod production. The Redis variant fails closed on outage — a replay guard that is unreachable counts as a ceremony no one completed.

TTL: 5 minutes.

## Verification

`verifyStepUpToken(token, expectedAccountId, allowedAmr)` rejects any of:

- Bad signature / expired
- Wrong `aud`
- `sub` ≠ expected account
- `jti` already consumed
- No intersection between token `amr` and caller's allow-list

Each outcome increments `osn.auth.step_up.verified{result}` with a distinct bounded label so the observability dashboard can distinguish "your ops team forgot to wire step-up through Settings" from "an attacker is trying to replay captured tokens".

## Observability

- `osn.auth.step_up.issued{factor}` — one per successful `/complete`
- `osn.auth.step_up.verified{result}` — one per gated-endpoint check
- Spans: `auth.step_up.begin`, `auth.step_up.complete`
- Redaction: `stepUpToken` / `step_up_token` are in the logger deny-list

## Threat model

A stolen access token alone cannot:
- Burn existing recovery codes and lock the legitimate user out.
- Swap the account email and pivot to a permanent takeover.

The attacker must additionally compromise either a passkey (hardware-bound) or the user's verified email inbox. Combined with [[sessions]] (`Sign out everywhere else`) this gives the user a narrow, survivable window.
