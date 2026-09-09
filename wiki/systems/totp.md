---
title: TOTP (RFC 6238) second factor
tags: [systems, auth, security, totp]
related:
  - "[[step-up]]"
  - "[[passkey-primary]]"
  - "[[recovery-codes]]"
  - "[[identity-model]]"
  - "[[account-recovery-factors]]"
  - "[[email]]"
last-reviewed: 2026-09-10
---

# TOTP (RFC 6238) second factor

A six-digit code from an authenticator app, derived from a shared secret and
the current 30-second step. It depends on neither the account's mailbox nor its
passkey device, and it works with no network — which is why
[[account-recovery-factors]] builds the whole recovery story on it.

**TOTP is not a login factor.** [[passkey-primary]] records that OTP and
magic-link primary login were removed on purpose, and nothing here reinstates
them. TOTP is a step-up factor at named purposes, and a **recovery** factor at
`POST /login/recovery/totp/complete` — which mints a *restricted* recovery
session, never an ordinary one. See [[recovery-codes#The three ways back in]].

Primitives live in `@shared/crypto/totp` (`shared/crypto/src/totp.ts`); the
service is `osn/api/src/services/auth/totp.ts` and the routes are
`osn/api/src/routes/auth/totp.ts`.

## The credential

`totp_credentials`, in `osn/db/src/schema/index.ts`.

| Column | Why it exists |
|---|---|
| `secret_ciphertext`, `iv` | The shared secret, AES-256-GCM encrypted. See below. |
| `key_version` | Which key the ciphertext is under. Always 1 — see [[#Rotation is not implemented]]. |
| `confirmed_at` | NULL until a code proves the user holds the secret. A row with NULL here is not a credential and every read filters on it. |
| `last_used_step` | The RFC 6238 step counter of the last accepted code — the single-use guard. |
| `last_used_at`, `label` | Settings display only. |

One **confirmed** credential per account, enforced twice: the service checks so
the user meets a clean 409, and a partial unique index
(`WHERE confirmed_at is not null`) holds when two requests race. Unconfirmed
rows are deliberately outside the index — an abandoned enrolment must not block
a retry.

### The secret cannot be hashed, so it is encrypted

Everything else credential-shaped in this schema is stored as a hash: recovery
codes, session tokens, OIDC authorization codes. A TOTP secret cannot be, because
verification derives the expected code from the raw HMAC key and therefore needs
the key back.

So it is encrypted under `OSN_TOTP_ENCRYPTION_KEY`, a Worker secret of 32 random
bytes, base64. What that buys is one specific thing: **the Worker's secrets and
its database are separate trust domains**, so a D1 dump on its own yields no
working second factor for anybody. It does nothing against an attacker who has
the running Worker.

Three details that are load-bearing:

- A **fresh 96-bit IV per encryption**, stored beside the ciphertext.
- The **accountId is the additional authenticated data**, so a row copied onto
  another account fails to decrypt rather than authenticating the wrong person.
- `key_version` is checked on the way back, so a ciphertext written under one
  key is refused rather than fed to another.

### Rotation is not implemented

`key_version` is a column, not a rotation path. `osn/api/src/lib/totp-secret-crypto.ts`
holds a single key and a single module constant, and `decryptTotpSecret` throws
on any other version. There is no map from version to key, so two keys cannot
coexist and no staged rotation is expressible.

The column exists so that adding rotation later is a code change rather than a
migration. Until that lands, **the only remedy for an exposed encryption key is
re-enrolment by every enrolled user.**

> [!warning] Installing a new key today breaks every enrolled account
> It decrypts every enrolled secret. A new key turns every second factor into an
> unverifiable ciphertext at once. `.github/workflows/set-osn-api-secret.yml`
> records the same policy — `rotate="never"` — and refuses to overwrite an
> existing value.

The two-key map that would fix it — `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`, new rows
encrypted under the highest version, each successful verify lazily re-encrypting
its row so the old key drains — is issue `xchromo/osn#968`.

**Fail-closed at boot.** A non-local tier without the key throws in
`build-deps.ts`, which `index.ts` turns into a 503 on every route — the same
posture as `OSN_SESSION_IP_PEPPER` and `OSN_PAIRWISE_SALT`. Local dev generates
an ephemeral key instead, exactly as `loadJwtKeyPair` does for the signing pair;
credentials enrolled locally stop decrypting after a restart. There is **no
plaintext path**: with no key resolvable, the service refuses to act.

### The pending secret never touches D1

Between `enroll/begin` and `enroll/complete` the secret is unconfirmed, and an
unconfirmed secret is not a credential. It lives in a `CeremonyStores` entry
(`pending_totp_enroll`, ten-minute TTL) with a Redis variant, encrypted with the
same key. The entry holds **base64 strings, not byte arrays**: the in-memory
store keeps the value by reference while the Redis store round-trips it through
`JSON.stringify`, so a `Uint8Array` there would pass every test and come back
from Upstash as `{"0":12,"1":200,…}`.

## Single use, and why the verifier returns a step

RFC 6238 §5.2 requires an accepted code to be refused for the rest of its step.
A stateless verifier cannot do that, so `verifyTotpCode` returns **the step it
matched** (`{ step } | null`) and the entry point records it.

Consumption is one conditional statement, never a read followed by a write:

```sql
UPDATE totp_credentials SET last_used_step = ?, last_used_at = ?
 WHERE id = ? AND confirmed_at IS NOT NULL
   AND (last_used_step IS NULL OR last_used_step < ?)
```

Zero rows changed means the step was already spent — a replay. A `SELECT` then
`UPDATE` would let two concurrent submissions of the same code both read a lower
stored step and both proceed, which is precisely the replay the RFC forbids.

Two consequences worth knowing:

- **The enrolment code is consumed at enrolment.** The row is inserted with
  `last_used_step` already set from the code the user typed into the form. That
  code is a real code and the most-observed one the credential will ever
  produce; a NULL there would leave it replayable for the rest of its window.
- **The next step still works.** Recording the step rather than blanket-refusing
  for the rest of the drift window is what lets a user enrol and immediately
  step up again — about ninety seconds apart at the default window.

## Throttling, and the one place this repo fails closed differently

Six digits over a ±1-step window is three acceptable codes in a million: even
odds inside a few hundred thousand attempts, which a rotating fleet reaches in
under an hour against a per-IP limit alone. RFC 4226 §7.3 requires a throttling
parameter, and per-IP limits are not it.

So every code check is additionally capped **per account** — five failures, then
fifteen minutes locked — through a second instance of the store in
`osn/api/src/lib/recovery-lockout-store.ts`, keyed on the resolved `accountId`.

> [!warning] The counter is scoped by ceremony, and it has to be
> `checkTotpCode` takes a required `scope` (`"step_up"` or `"recovery"`) and
> keys the counter `accountId` or `recovery:<accountId>`. Both surfaces verify
> the same credential, but `POST /step-up/totp/complete` is authenticated while
> `POST /login/recovery/totp/complete` is not — and the latter accepts a
> **handle**, which is public. On one shared counter, five requests from anyone
> who knew a handle would lock the owner's step-up for fifteen minutes, and with
> it `passkey_register`, `recovery_generate`, `totp_enroll`, `totp_disable`,
> `account_delete` and `account_export`, for any user whose only non-passkey
> factor is TOTP — repeatedly, and indefinitely. Fail-closed made it worse, not
> better: one Redis error would have locked both surfaces at once.
>
> Splitting costs five extra guesses per window against three accepted codes in
> a million. The `osn.auth.totp.lockout` counter carries a `scope` attribute so
> a dashboard can tell which surface is being ground.

> [!important] TOTP's lockout fails closed; the recovery-code one fails open
> They are the same code with opposite postures, and the difference is
> deliberate. Recovery codes keep a 64-bit search space during a Redis outage,
> so failing open loses a redundant defence and avoids locking everyone out.
> TOTP has about twenty bits, so failing open removes the *only* effective
> defence. What failing closed costs is a TOTP ceremony during a Redis error;
> passkey and OTP step-up are unaffected, so no account becomes unreachable.

## Every failure looks the same

Wrong code, replayed code, no credential on the account, and locked-out all
answer one message and cost roughly one verification. An absent credential is run
against `verifyTotpCode`'s dummy secret so it does not answer faster — otherwise
the route would tell anyone who can reach it whether an account has a second
factor. Which failure it actually was appears only on
`osn.auth.totp.verified{result}`.

## Routes

| Route | Step-up gate | Notes |
|---|---|---|
| `POST /totp/enroll/begin` | `totp_enroll` | Returns `otpauthUri` + `totpSecret`, once, under `Cache-Control: no-store`. 409 if a confirmed credential exists. |
| `POST /totp/enroll/complete` | none | `begin` carried the gate, and the pending secret only exists because a gated `begin` created it. |
| `DELETE /totp` | `totp_disable` | Idempotent. Writes the security event, sends the notice. |
| `GET /totp/status` | none | `enrolled`, `label`, `lastUsedAt`, `createdAt`. Never the secret, the ciphertext or the step. |
| `POST /step-up/totp/complete` | none | Exchanges a code for a step-up token with `amr: ["totp"]`. |

There is **no `/step-up/totp/begin`**, and that is not an omission: TOTP is
challenge-free, so a `begin` would have nothing to mint, park or send. Whether
the factor is available at all is what `GET /totp/status` answers.

Enrolment and disable are step-up gated for the reason passkey registration is:
without it, a stolen access token silently binds an attacker's authenticator,
and every gate that accepts a `totp` AMR would then accept the attacker.

The two wire fields that carry secret material are named `totpSecret` and
`otpauthUri` **to match the logger deny-list entries** in
`shared/observability/src/logger/redact.ts`. Renaming either silently un-redacts
the shared secret in operator logs.

## Surfaces

`<TotpView>` (`osn/ui/src/auth/TotpView.tsx`) is the only place a user meets
this system. `@musubi/social` mounts it in Settings → Security, between
`<PasskeysView>` and `<RecoveryCodesView>`, inside the lazy `SecuritySection`
chunk that already carries `@simplewebauthn/browser`.

| State | What it shows |
|---|---|
| Not enrolled | "Add an authenticator app", which runs a `totp_enroll` step-up, calls `enrollBegin`, and opens the enrolment panel |
| Enrolling | The QR code, the base32 key as selectable text, an optional device label, and a six-digit confirmation |
| Enrolled | The label, `createdAt`, `lastUsedAt`, and a `totp_disable`-gated **Remove** |

Three properties of that panel are load-bearing rather than cosmetic:

- **The secret is shown once.** `enrollBegin` is the only source, `GET /totp/status`
  never returns it, and it lives in one signal cleared on success, on cancel and
  on unmount. There is no second read to go wrong.
- **The base32 key is the QR's text alternative**, which is why it is selectable
  text rather than part of the image. The `aria-label` on the SVG says what the
  graphic is and points at that key; it never carries the `otpauth://` URI,
  because an accessible name is read aloud and copied into tooling and that URI
  *is* the secret.
- **The QR is generated in-repo** (`osn/ui/src/lib/qr.ts`, rendered by
  `osn/ui/src/components/ui/qr-code.tsx`) — byte mode, error-correction level M,
  versions 1 to 15. Nothing in the monorepo could draw one and `bunfig.toml`
  sets a three-day `minimumReleaseAge`, so this cost no dependency. Its tests
  pin the parts a rendering assertion cannot see: the specification's
  Reed-Solomon worked example, the eight level-M format words, the block table
  against capacity derived from the symbol's own layout, and two golden
  matrices verified against an independent decoder.

> [!warning] A wrong QR looks completely right
> Both defects the encoder had in development — a reversed generator polynomial
> and format bits written least-significant-first — render a plausible symbol
> that scans as nothing. Anything that changes `qr.ts` must keep those tests
> green; "it still looks like a QR code" is not evidence.

The authenticator may also authorise **its own removal**: `<TotpView>` passes a
`TotpClient` to the disable ceremony's `<StepUpDialog>`, so holding the device
is accepted as proof for unbinding it.

## Which gates a `totp` token reaches

The full table, and the reasoning, is in [[step-up]] — it belongs with the other
factors rather than here. The short version: `totp` is admitted wherever an
emailed OTP already is, **except** `passkey_delete`, which stays WebAuthn-only,
and `email_change`, whose OTP arm proves control of the current mailbox in a way
a TOTP seed does not.

## Lifecycle

- **Account deletion.** The credential is removed in the same batch as passkeys
  and recovery codes, on **both** soft delete and hard delete
  (`services/account-erasure.ts`). The foreign key cascades only when the
  `accounts` row itself goes, which is seven days after a soft delete — without
  the explicit delete a tombstoned account would keep a working second factor
  through the whole grace window.
- **DSAR export.** `services/account-export.ts` emits a `totp` section with the
  label and timestamps, on the same footing as the `passkeys` section. Never the
  secret or its ciphertext: an export is a document the subject may forward
  anywhere, and the secret is a live credential rather than a record about them.

## Observability

| Signal | Attributes |
|---|---|
| `osn.auth.totp.operations` | `op` (`enroll_begin`, `enroll_complete`, `disable`, `status`, `verify`), `result` |
| `osn.auth.totp.duration` | same, as a histogram |
| `osn.auth.totp.verified` | `result` — `ok`, `invalid`, `replayed`, `not_enrolled`, `locked_out` |
| `osn.auth.totp.lockout` | `result` — `recorded`, `locked`, `reset` |
| `osn.auth.step_up.issued` | gains `factor="totp"` |
| `osn.auth.security_event.recorded` | gains `totp_enrolled`, `totp_disabled` |

Spans: `auth.totp.<op>`. No accountId, credential id, step counter or code
appears in any attribute. `replayed` climbing on a real account is the signal
worth an alert — it means correct codes are arriving twice.

## Threat model

What a stolen access token alone still cannot do: enrol an authenticator, remove
one, or mint a step-up token. Each needs a fresh ceremony.

What a stolen access token **plus** a cloud-synced authenticator seed can do: add
a passkey, generate recovery codes, delete or export the account, acknowledge
security events. All of those already accept an emailed OTP, so admitting TOTP
does not widen them.

What it cannot do **directly** is delete the victim's existing passkeys or change
the account email. Neither `passkeyDeleteAllowedAmr` nor `emailChangeAllowedAmr`
admits a `totp` AMR.

> [!warning] Both were reachable in two hops, and the second hop is now closed
> Those two lists narrow the **direct** path and nothing else. Both admit
> `webauthn`, and a passkey registered a minute ago mints a `webauthn` AMR
> exactly like one the user has held for a year — so any factor admitted at
> `passkeyRegisterAllowedAmr` used to get there by registering a credential and
> asserting it:
>
> 1. `POST /step-up/totp/complete` with `purpose: "passkey_register"` — a token
>    with `amr: ["totp"]`.
> 2. `POST /passkey/register/{begin,complete}` — the attacker's authenticator is
>    now a registered passkey on the victim's account.
> 3. `POST /step-up/passkey/complete` asserting **that** passkey with
>    `purpose: "passkey_delete"` — this mints `amr: ["webauthn"]`, which
>    `passkeyDeleteAllowedAmr` admits.
> 4. `DELETE /passkeys/:id` for each real passkey. The last-passkey guard needs
>    only one survivor, and the attacker's credential is one.
>
> Email change fell to the same pivot with `purpose: "email_change"` at step 3,
> and that was the worse end of it: its second factor is an OTP to the **new**
> address, and `POST /account/email/begin` is gated on the access token alone,
> so the current-mailbox proof that list was written for is not what the caller
> ends up presenting. The outcome was a permanent, mailbox-independent takeover.
>
> **Step 4 now fails.** `passkeys.provenance_amr` records the effective strength
> of the ceremony chain behind each credential, and the step-up verifier refuses
> `passkey_delete` and `email_change` to a credential registered under a weaker
> AMR, against anything older than itself, for 72 hours. The attacker's
> credential at step 2 is stamped `totp`, so the token minted at step 3 is
> refused at step 4 — while a genuine owner, asserting a passkey they already
> held, is refused nothing. See [[step-up#Credential provenance]].
>
> The inheritance is what makes it hold rather than move: a passkey registered
> under a `webauthn` step-up takes the asserting credential's provenance, so the
> pivot cannot be laundered by inserting one more registration.

The full gate table is in [[step-up]].

A TOTP secret is an authentication credential bound to a person, so it carries
rows in [[data-map]] and [[retention]] (`wiki/compliance/data-map.md`,
`wiki/compliance/retention.md`).
