---
title: Account recovery factors — TOTP and email-verified recovery
tags: [architecture, auth, security, recovery, totp]
related:
  - "[[passkey-primary]]"
  - "[[recovery-codes]]"
  - "[[step-up]]"
  - "[[sessions]]"
  - "[[identity-model]]"
last-reviewed: 2026-09-09
---

# Account recovery factors — TOTP and email-verified recovery

The design for two new ways back into an OSN account, and the six issues it
splits into. Written 2026-09-09 and amended after a stress-plan pass; every
finding from that pass is closed below, in the text. Actionable work lives in
GitHub Issues — this page holds the decisions those issues are built from.

## Problem

An OSN account is reachable by exactly two things: a WebAuthn credential, or
one of ten recovery codes. Both live on objects a person can lose in one
event. A user whose only phone is lost or wiped, and who never printed the
recovery codes, is locked out permanently. There is no support-side reset and
no second independent factor.

## Non-goals, and the decision they preserve

[[passkey-primary]] records that OTP and magic-link **primary login were
removed on purpose**. Nothing here reinstates them. No new factor
mints an ordinary session, and no new factor becomes a login factor. Phishing
resistance of the sign-in path is unchanged.

Out of scope: SMS, support-operated resets, trusted-contact recovery, and any
change to cire or pulse (they inherit through OIDC).

## What is added

### A. TOTP (RFC 6238), enrolled from an authenticator app

Independent of both the mailbox and the passkey device, and usable offline.
Two roles, and the second is what makes it worth building:

1. **A step-up factor** — at named purposes only, see §D.
2. **A recovery factor** — `POST /login/recovery/totp/complete` mints the same
   restricted recovery session §B describes. This is settled, not optional: a
   step-up-only TOTP would do nothing for the problem statement, since it is
   reachable only by someone already signed in.

TOTP is not a login factor.

### B. Recovery ends in a restricted session, enforced by audience

`POST /login/recovery/email/begin` takes an **email identifier only** (not a
handle — a handle is public and this endpoint sends mail) and always returns
the same 202. Where it resolves, a code goes to the address on file.

`POST /login/recovery/email/complete` and `POST /login/recovery/totp/complete`
exchange the factor for a **restricted recovery session**.

The restriction is a **distinct token audience**, not a flag:

- The access token is minted with `aud: "osn-recovery"`, and `osn-recovery` is
  added to the reserved OIDC client-id deny-list.
- Every existing verifier already pins `aud === "osn-access"` — the four
  osn-api entry points and the three downstream services verifying over JWKS
  (`pulse/api`, `zap/api`, `cire/api` through `@shared/osn-auth-client`). All
  seven therefore reject it with **no change to any of them**. This is the
  whole reason for the audience: a boolean claim on an `osn-access` token
  would be fail-open at every verifier not individually updated, three of
  which deploy on someone else's cadence.
- `resolvePasskeyEnrollPrincipal` is the **only** resolver taught to accept the
  new audience.
- `sessions.restrictedUntil` exists as the source of truth for **rotation**:
  `refreshTokens` copies it forward and re-mints with the recovery audience
  while it is set. `completePasskeyRegistration` clears it. Without this the
  restriction would expire on the first silent refresh, five minutes in.
- The restricted session gets a **short absolute `expiresAt` (15 minutes) and
  no sliding extension**. A credential with exactly one purpose must not
  outlive the window in which that purpose is plausible, and a 30-day sliding
  session that can do nothing is a dead end that also consumes a slot against
  `MAX_SESSIONS_PER_ACCOUNT`.
- `/login/recovery/email/complete` sets the session cookie exactly as
  `/login/recovery/complete` does, or `completePasskeyRegistration`'s
  other-session sweep cannot resolve the caller and returns `session_stale`.
- **The cookie is also a way out, and it is closed.** Setting that cookie is
  not free: `GET /authorize` resolves the signed-in user from the session
  cookie, not from an access token, so the audience — which stops every
  access-token verifier — does not reach that decision at all. A restricted
  session would have completed an OIDC authorization and signed the user into
  pulse, cire and zap: full access at another service, from a session that has
  none at the issuer, and the same laundering the cross-device rule exists to
  stop. So `verifyRefreshToken` **rejects a restricted session by default**,
  and token refresh is the only caller that opts in. Found while building
  issue 3, closed there; a `/authorize` check alone would not have covered the
  next consumer of that function. See [[oidc-provider]].
- The per-account passkey cap is **not** bypassed, and an account already at it
  cannot recover: enrolment refuses before the step-up gate, and a restricted
  session cannot mint the step-up a deletion needs. Tracked as
  `xchromo/osn#970`, to be decided with the provenance work in issue 5, since
  both turn on when a recovery-enrolled credential may remove an older one.

**The enrolment gate.** `beginPasskeyRegistration` refuses without a
`passkey_register` step-up whenever the account has ≥1 passkey — which is the
*common* recovery case, since losing a phone does not delete its passkey row.
A recovery-audience token therefore **bypasses that step-up**: the email OTP or
TOTP code that minted the session already was a ceremony, at an AMR strength
`passkeyRegisterAllowedAmr` accepts. The alternative — letting a
restricted session mint step-up tokens — would let it reach
`/recovery/generate`, `DELETE /account`, `GET /account/export` and
`/account/email/complete`, i.e. everything the restriction claims to prevent.

**And that strength is enforced, not assumed.** `issueRecoverySession` takes a
**required** `amr` — `otp`, `totp` or `webauthn` — refuses at mint time anything
`passkeyRegisterAllowedAmr` does not admit, and writes the value to
`sessions.restricted_amr`. The gate reads it back off the caller's own session
row, so the bypass turns on the recorded factor rather than on the audience
alone: no route can mint a session whose factor the gate would have refused, an
operator narrowing the allow-list withdraws the bypass from sessions already
issued, and a restricted row with no recorded factor admits nothing. Whichever
route ends a recovery therefore has to name the factor it verified — that
argument is how the endpoints in §B connect to this gate.

### C. Recovery is loud — most of which already exists

`consumeRecoveryCode` **already** deletes every session on the account, writes
a `recovery_code_consume` security event and detaches a `recovery-consumed`
notice. That is not new scope. What is new:

- Email and TOTP recovery must **match** that existing behaviour.
- A **provenance-aware cooldown**, added to all three recovery paths.

### D. The cooldown, by provenance — not a global lock

A global 72-hour lock on `passkey_delete` and `email_change` after any recovery
protects the wrong party. Trace it: an attacker with the mailbox recovers,
every other session is revoked, they enrol their own passkey (satisfying the
`passkey_register` step-up with an OTP to the mailbox they now own). The owner
signs in with their real passkey, sees the notice — and cannot delete the
attacker's credential or move off the compromised mailbox for three days. The
attacker moved first, so a symmetric lock hands them the window. The
lost-device case fails the same way: the owner cannot revoke the passkey on the
stolen phone.

So the cooldown is asymmetric:

- A step-up token whose AMR came from a credential that **predates** the
  recovery may delete any passkey and change the email **immediately**. That is
  the owner acting, and a pre-recovery passkey is exactly the proof of
  ownership that should unlock action.
- A step-up minted from the **recovery-enrolled** credential, or from OTP, may
  not delete pre-recovery passkeys or change the email for 72 hours.
- **One recovery per 72 hours per account**, so the mailbox holder cannot
  simply re-run it.
- The `recovery-used` notice carries a **"this wasn't me"** path that revokes
  the recovery-enrolled credential and the recovery session family. Without
  this the owner has a warning and no lever.

[[musubi-identity-migration]] step 8 walks an operator through
recovery-login → OTP step-up → enrol passkey → delete the old passkeys. Under a
global lock that runbook breaks; under the asymmetric rule it still works,
because the operator's step-up comes from the pre-recovery credential. The
runbook is re-checked and updated in the same PR as the cooldown.

### The same rule closes the register-then-assert pivot

Provenance is not only about recovery. The identical weakness exists with no
recovery in sight, and predates it: `passkeyDeleteAllowedAmr` and
`emailChangeAllowedAmr` are narrow because they exclude `otp` and `totp`, but
both admit `webauthn` — and a passkey **registered a minute ago under an `otp`
or `totp` step-up** mints a `webauthn` AMR indistinguishable from one the user
has held for a year. Register a credential of your own, assert it, and you hold
a token either gate accepts. [[totp#Threat model]] walks the four requests.

So the record the cooldown needs is not "was this passkey enrolled during a
recovery" but **the AMR the passkey was registered under**, whatever ceremony
produced it. Widen `passkeys.enrolledViaRecoveryAt` to carry that, and the
asymmetric rule above covers both cases with one mechanism:

- A `passkey_delete` or `email_change` step-up asserted by a credential
  registered under a `webauthn` AMR is the owner acting — unrestricted.
- One asserted by a credential registered under `otp` or `totp` may not delete a
  passkey that predates it, nor change the email, until the cool-down elapses.

The user's own second device is registered under a `webauthn` step-up in the
ordinary case, so the common path is unaffected; the restriction lands only
where the new credential's own provenance is weaker than the credential it
would remove.

This is scoped into `xchromo/osn#952` alongside the recovery cooldown, because
they are one column and one comparison.

## Shape of the change

| Area | Change |
|---|---|
| `@shared/crypto` | New `totp.ts` on its **own subpath export** (`./totp`, like `./timing-safe`) so it does not drag `@osn/db` in through the barrel. Base32 gen/encode/decode, RFC 6238 over WebCrypto HMAC-SHA1, ±1 step drift, constant-time compare. No new npm dependency, so no 3-day soak. |
| `@osn/db` | `totpCredentials` (`secretCiphertext`, `iv`, `keyVersion`, `confirmedAt`, `lastUsedAt`). `sessions.restrictedUntil`. `passkeys.enrolledViaRecoveryAt`. `accounts.lastRecoveredAt`. Migrations number sequentially from `0007_`. |
| `@osn/api` | TOTP service + step-up-gated routes; the `osn-recovery` audience and its rotation carry-forward; email + TOTP recovery routes; provenance cooldown; new limiters; new security-event kinds. |
| `@shared/email` | `totp-enrolled`, `totp-disabled`, `otp-recovery`, `recovery-used`. |
| `@osn/client` | `TotpClient`; `RecoveryClient.emailRecoveryBegin/Complete`, `totpRecoveryComplete`. Ships **with its API phase**, not in a trailing PR. |
| `@osn/ui` / `@osn/social` | `<TotpView>` in Settings → Security; TOTP factor in `<StepUpDialog>`; "email me a code" on `<RecoveryLoginForm>`. |

### TOTP secrets at rest

"Store only what verification needs" is not available — RFC 6238 verification
needs the raw HMAC key. Plaintext in D1 is not acceptable either: it would be
the weakest secret in a schema where recovery codes are hashed, session tokens
are hashed and IPs are HMAC-peppered, and a dump would yield a working step-up
factor for every enrolled account.

So: a new Worker secret `OSN_TOTP_ENCRYPTION_KEY` (32 random bytes, base64),
per environment, imported once in `build-deps.ts` as an AES-GCM `CryptoKey` and
carried on `AuthConfig` — exactly the shape `OSN_SESSION_IP_PEPPER` already
uses, including **failing closed at boot** in non-local tiers when absent. The
Worker's secrets and its database are separate trust domains. The pending,
not-yet-confirmed secret during enrolment lives in a `CeremonyStores` entry
with a Redis variant, never in D1.

### Which step-up allow-lists admit `totp`

There is no single gate; there are three allow-lists, and one is deliberately
WebAuthn-only. Naming them is not optional.

| Allow-list | Admits `totp`? |
|---|---|
| `passkeyRegisterAllowedAmr` | **Yes** |
| `recoveryGenerateAllowedAmr` | **Yes** |
| `passkeyDeleteAllowedAmr` | **No — stays `["webauthn"]`** |

`passkeyDelete` gates both `DELETE` and `PATCH /passkeys/:id`. Its existing
rationale holds with TOTP present: the caller necessarily holds a passkey, so
requiring one costs nothing. Admitting TOTP there would make a stolen access
token plus a cloud-synced authenticator seed enough to delete the victim's real
passkeys — which the cooldown would then stop the victim undoing.

Three knock-on edits an implementer will otherwise miss:

- The AMR arrays are typed `readonly ("webauthn" | "otp")[]` at three sites in
  `config.ts`. Adding `totp` is a type widening, not a one-line join.
- `issueStepUpToken` maps factor to AMR with a **two-branch ternary** whose
  else-arm is `"recovery"`. A `totp` factor added to `StepUpFactor` without
  touching that line mints `amr: ["recovery"]`, which no allow-list admits.
- `<StepUpDialog>`'s `passkeyOnly` prop needs a defined meaning with a third
  factor present.

TOTP **enrolment and disable are themselves step-up gated**, for the same
reason passkey registration is: a stolen access token must not silently bind an
attacker's seed.

### Enumeration, timing and flood control on `/login/recovery/email/begin`

A uniform 202 is not sufficient here. Every existing OTP send *awaits* the
provider call, and a Resend round-trip is hundreds of milliseconds against a
sub-millisecond probe — the send itself is the oracle. And the recipient is the
account's own address, so an unthrottled endpoint floods the victim's inbox.

- Dispatch the send **detached with a timeout**, the pattern `notifyRecovery`
  already uses, so both branches return at probe cost.
- Add a **per-resolved-account cap** (3 per 24 h) through the existing
  `AccountCapLimiter` family, keyed on `accountId` — never on the submitted
  identifier — and still answering 202 when exceeded. Per-IP limits alone are
  defeated by a rotating fleet, which this issuer already sees.
- Extend the turnstile endpoint literal union and gate `begin`.
- Complete side: 6-digit code, existing `MAX_OTP_ATTEMPTS` per entry, per-account
  lockout reusing the `recovery-lockout-store.ts` shape.

## Sequencing — six issues, strictly in order

They share far more than four files. The full overlap set, which is also the
reason nothing here runs concurrently:

- `shared/observability/src/metrics/attrs.ts` — `StepUpFactor`,
  `AuthRateLimitedEndpoint`, `SecurityEventKind`, `AuthMethod`, `StepUpPurpose`.
- **All three rate-limiter builders** — `routes/auth/limiters.ts`,
  `lib/redis-rate-limiters.ts`, `lib/native-rate-limiters.ts`. A new slot
  missing from any one makes `createAuthRouteContext` throw
  `must have a check() method` **at boot**. This is the omission that ships a
  Worker which fails on first request.
- `osn/api/src/services/auth/{index,context,config,stores,step-up,helpers,tokens}.ts`,
  `lib/redis-ceremony-stores.ts`, `lib/auth-derive.ts`,
  `routes/auth/{index,step-up,context,response-schemas}.ts` (two hard-coded
  purpose unions in `step-up.ts`), `metrics.ts`, `build-deps.ts`, `index.ts`
  (`Env`), `wrangler.toml`.
- `osn/db/src/schema/index.ts` and `osn/db/drizzle/` — sequential numbering.
- `osn/client/src/step-up.ts` mirrors `StepUpPurpose` **by hand**.
- The wiki pages every phase makes stale: [[step-up]], [[passkey-primary]],
  [[recovery-codes]], [[email]], [[identity-model]].

| # | Issue | Complexity |
|---|---|---|
| 1 | `@shared/crypto` TOTP primitives on a `./totp` subpath | 2 |
| 2 | osn-api TOTP enrol / verify / disable, named step-up allow-lists, `TotpClient` | 5 |
| 3 | The `osn-recovery` audience: minting, rotation carry-forward, enrolment acceptance, 15-min absolute TTL. **No public route.** | 5 |
| 4 | `/login/recovery/{email,totp}/*`, caps, detached send, notices, client methods | 5 |
| 5 | Provenance-aware cooldown across all three recovery paths, "this wasn't me" revoke, runbook update | 5 |
| 6 | `@osn/ui` + `@osn/social` surfaces for TOTP and email recovery | 3 |

Issue 3 exists separately because the audience primitive reaches `tokens.ts`,
`helpers.ts`, `auth-derive.ts`, `passkeys.ts`, `context.ts` and the refresh
path, and needs its own tests against **every** verifier entry point. Reviewed
in one diff alongside a new unauthenticated mail-sending endpoint, no security
pass holds it all at once.

## Global constraints for every phase

- **Fail closed** on every limiter, store and boot-time secret check.
- A new limiter slot goes into **all three** builders in the same commit.
- No secret in a log line, a metric attribute or an error body. Bounded metric
  attributes only; no `console.*`; no raw OTel constructors.
- Constant-time compare for every code check.
- **Every accepted code is single use**, TOTP included. RFC 6238 §5.2 requires
  it and `verifyTotpCode` cannot: it is stateless, so the entry point records
  the accepted step against the account and refuses a repeat for the rest of
  that step. A TOTP code mints a session at
  `POST /login/recovery/totp/complete`, so a code replayed off the wire is an
  account takeover rather than a repeated ceremony.
- **Both TOTP entry points are throttled per account**, not only per IP — the
  step-up verify and `POST /login/recovery/totp/complete`. RFC 4226 §7.3
  requires a throttling parameter, and the arithmetic says why: six digits over
  ±1 step is three acceptable codes in a million, even odds inside a few
  hundred thousand attempts, which a rotating fleet reaches in under an hour
  against a per-IP limit alone. `osn/api/src/lib/recovery-lockout-store.ts` is
  the existing shape to reuse.
- Enumeration-safe: uniform response **and** comparable latency, which for a
  mail-sending branch means detaching the send.
- Every new unauthenticated endpoint is rate limited per IP **and** capped per
  resolved account.
- Tests: `it.effect` + `createTestLayer()`; route tests via
  `createXxxRoutes(createTestLayer())`. TDD for anything with logic.
- Wiki updated in the same PR as the code it describes, `last-reviewed` bumped.
- The compliance pages count as wiki: a TOTP secret is an authentication
  credential bound to a person, and `lastUsedAt` sits on the same footing as
  `passkeys.last_used_at`, which already has a row in both. The phase that adds
  a column adds its row to [[compliance/data-map]] (`wiki/compliance/data-map.md`
  — purpose, lawful basis, retention, who can read it) and to
  [[compliance/retention]] (`wiki/compliance/retention.md` — how long, and what
  deletes it).
- A changeset in every PR, package names matching the workspace `name` exactly.
