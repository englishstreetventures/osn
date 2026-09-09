---
title: Step-up (sudo) tokens
tags: [systems, auth, security]
related:
  - "[[identity-model]]"
  - "[[totp]]"
  - "[[recovery-codes]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
last-reviewed: 2026-09-10
---

# Step-up (sudo) tokens

The most sensitive endpoints require short-lived, high-assurance tokens. A stolen access token on its own then cannot reach destructive actions (recovery-code generation, email change).

## When step-up is required

There are **four** allow-lists, not three, and only three of them are config
knobs. `recoveryGenerateAllowedAmr` is read by five separate verifiers despite
its name, so widening it widens all five — the table below is by gate rather
than by knob for exactly that reason.

| Gate | Allow-list | `webauthn` | `otp` | `totp` |
|---|---|---|---|---|
| `POST /recovery/generate` | `recoveryGenerateAllowedAmr` | yes | yes | **yes** |
| `DELETE /account` | `recoveryGenerateAllowedAmr` | yes | yes | **yes** |
| `GET /account/export` (DSAR) | `recoveryGenerateAllowedAmr` | yes | yes | **yes** |
| `POST /account/security-events/:id/ack` + `/ack-all` | `recoveryGenerateAllowedAmr` | yes | yes | **yes** |
| `/internal/step-up/verify` (Pulse / Zap app delete) | `recoveryGenerateAllowedAmr` | yes | yes | **yes** |
| `POST /passkey/register/{begin,complete}` | `passkeyRegisterAllowedAmr` | yes | yes | **yes** |
| `POST /totp/enroll/begin` | `passkeyRegisterAllowedAmr` | yes | yes | **yes** |
| `DELETE /totp` | `passkeyRegisterAllowedAmr` | yes | yes | **yes** |
| `DELETE /passkeys/:id` and `PATCH /passkeys/:id` (rename) | `passkeyDeleteAllowedAmr` | yes | **no** | **no** |
| `POST /account/email/complete` | `emailChangeAllowedAmr` (`context.ts`) — the one set with no `AuthConfig` field | yes | yes | **no** |

Two rows are deliberately narrower than the rest, and both would be easy to
widen by accident:

- **`passkeyDeleteAllowedAmr` stays `["webauthn"]`.** By construction the caller
  already holds a passkey — the last-passkey guard fires otherwise — so
  requiring one costs nothing (S-L4).
- **Email change keeps a set of its own, and no knob reaches it.** Its `otp` arm
  proves control of the **current** mailbox; a TOTP seed does not. Email change
  is the silent pivot to permanent takeover, so it is the one gate where the two
  factors are not interchangeable — and the one a deployment may not widen. It
  lives in `context.ts` beside its three siblings rather than inline at the
  verifier, so all four sets are read in one place.

> [!caution] Both narrow rows narrow the **direct** path only
> Both admit `webauthn`, and a passkey registered a minute ago mints a
> `webauthn` AMR exactly like one the user has held for a year. So any factor
> admitted at `passkeyRegisterAllowedAmr` reaches both gates in two hops: step
> up with that factor, register a credential of your own, assert **that**
> credential for the purpose you want, and you hold a token either list accepts.
>
> At `passkey_delete` the rest of the account's passkeys then go; the
> last-passkey guard needs only one survivor and the new credential is one. At
> `email_change` the second factor is an OTP to the **new** address, which the
> caller chose — `POST /account/email/begin` is gated on the access token alone
> — so the mailbox proof the narrow list was written for is not proof of the
> *current* mailbox once the AMR arrived this way.
>
> This is open to `otp` as much as to `totp`, and predates both TOTP and this
> table. Closing it needs credential provenance — the AMR a passkey was
> registered under, and a cool-down on `passkey_delete` and `email_change` for
> one enrolled under a weaker factor. That is `xchromo/osn#952`; the
> walk-through is in [[totp#Threat model]].

Everywhere else, `totp` is admitted precisely where an emailed OTP already is.

The caller presents the token either as an `X-Step-Up-Token` header or a `step_up_token` body field (email change uses body-only).

## Ceremony

Two factors, both authenticated via the caller's existing Bearer access token:

| Route | Purpose |
|---|---|
| `POST /step-up/passkey/begin` | WebAuthn assertion options, scoped to the caller's account |
| `POST /step-up/passkey/complete` | Verifies signed assertion, returns `{ step_up_token, expires_in }` |
| `POST /step-up/otp/begin` | Sends a 6-digit OTP to the account's verified email |
| `POST /step-up/otp/complete` | Verifies code, returns `{ step_up_token, expires_in }` |
| `POST /step-up/totp/complete` | Verifies a code from the account's authenticator app, returns `{ step_up_token, expires_in }` |

Step-up OTPs are keyed separately from login OTPs — a login code cannot authorise a sensitive action, and a step-up code cannot complete a login.

TOTP has **no `begin`**: it is challenge-free, so there is nothing to mint, park
or send. Whether the factor is available is what `GET /totp/status` answers. A
TOTP code is single-use per RFC 6238 §5.2 and the step it matched is recorded
against the credential — see [[totp]].

## Purpose binding

An amr-only check says *how* the user proved themselves, not *what for*. Without more, a token minted to confirm an email change can be replayed against any other gate on the same allow-list — a confused deputy. So `/step-up/{passkey,otp}/complete` accept an optional `purpose`, stamped into the token as a `purpose` claim, and a gate that names a purpose refuses every token minted for a different one (`result="wrong_purpose"`).

| Value | Gate |
|---|---|
| `recovery_generate` | `POST /recovery/generate` (S-M1) |
| `account_delete` | account deletion |
| `account_export` | account export |
| `pulse_app_delete`, `zap_app_delete` | downstream app-data deletion, via `verifyStepUpForExternalPurpose` |
| `passkey_register` | `POST /passkey/register/{begin,complete}` past the first credential |
| `passkey_delete` | `DELETE /passkeys/:id` **and** `PATCH /passkeys/:id` — rename shares the claim |
| `email_change` | `POST /account/email/complete` |
| `security_event_ack` | both acknowledge paths |
| `totp_enroll` | `POST /totp/enroll/begin` |
| `totp_disable` | `DELETE /totp` |

The union lives in `StepUpPurpose` (`shared/observability/src/metrics/attrs.ts`), mirrored client-side as `StepUpPurpose` in `@osn/client` so the browser SDK stays free of a server dep. `StepUpDialog` takes a `purpose` prop and forwards it to whichever `/complete` route the user picks.

A gate that names a purpose rejects a **purposeless** token too — there is no accept-legacy fallback, so any new client of such a gate must send `purpose`.

## Token shape

ES256 JWT signed with the same key as access tokens (reuses `/.well-known/jwks.json`). Claims:

```json
{
  "sub": "acc_<accountId>",
  "aud": "osn-step-up",
  "iss": "<AuthConfig.issuerUrl>",
  "amr": ["webauthn"],
  "purpose": "recovery_generate",
  "jti": "<uuid>",
  "iat": 1776988800,
  "exp": 1776989100
}
```

- **aud** — fixed literal `"osn-step-up"` so the token cannot be cross-used as an access token.
- **iss** — (O1) pinned to `AuthConfig.issuerUrl`; the verifier rejects any other issuer. Every verify also allows a **30s `clockTolerance`** for benign signer/verifier skew. Both access and step-up tokens share this contract.
- **sub** — `accountId` (not profileId). The verifier requires a match against the caller's resolved account.
- **amr** — RFC 8176 authentication-method-reference array. Verifier intersects with a caller-supplied allow-list. `issueStepUpToken` maps the ceremony factor to it through an exhaustive record (`passkey → webauthn`, `otp → otp`, `totp → totp`, `recovery_code → recovery`); a factor added without an entry is a compile error rather than a token no allow-list admits.
- **purpose** — optional; present only when the caller named a ceremony. See **Purpose binding** above.
- **pk_id**, **pk_provenance**, **pk_created_at** — the asserted credential's id, its `passkeys.provenance_amr` and its `created_at` in unix seconds. Present together, and only when the ceremony was a passkey assertion. See **Credential provenance** below.
- **jti** — single-use replay guard. Backed by a `StepUpJtiStore` interface (see `osn/api/src/services/auth/stores.ts`) with two implementations: an in-memory Map for single-process dev/test, and `createRedisJtiStore` (`osn/api/src/lib/step-up-jti-store.ts`) for multi-pod production. The Redis variant fails closed on outage — a replay guard that is unreachable counts as a ceremony no one completed.

TTL: 5 minutes.

## Credential provenance

`amr: ["webauthn"]` says a WebAuthn ceremony happened. It does not say whether
the credential behind it was one the user has held for a year or one registered
a minute ago under an emailed code — and for two gates that difference is the
whole question, because a caller who can register a credential can assert it.

So `passkeys.provenance_amr` records the **effective** strength of the ceremony
chain behind each credential, and `completeStepUpPasskey` carries it into the
token:

| How the row was created | Stamp |
|---|---|
| Bootstrap — the account had **zero** passkeys | `webauthn` |
| `passkey_register` step-up with `amr: ["otp"]` | `otp` |
| `passkey_register` step-up with `amr: ["totp"]` | `totp` |
| `passkey_register` step-up with `amr: ["webauthn"]` | the asserting credential's own provenance |
| The restricted recovery session's enrolment bypass | `recovery` |
| Rows predating the column | `NULL`, read as `webauthn` |

Two rows carry the design and are worth reading twice.

**Inheritance.** Without it the pivot is three requests instead of two: register
A under `otp`, assert A to register B — a genuine `webauthn` step-up — and B
would be stamped `webauthn`. Recording the raw AMR of the registering step-up
closes nothing.

**Inheritance is effective, not raw.** Once the asserting credential is past its
own 72-hour window it may perform these deletions itself, so a child it
authorises cannot be made safer by restricting it. Raw inheritance would
restrict every device in a lineage for the life of the account — and the common
reason a user adds a device by OTP is that the first one is hard to reach.

**Bootstrap is `webauthn`.** The account's first passkey follows an email-OTP
registration, so a literal reading would stamp it `otp` — and through
inheritance that would restrict every credential the account ever derived from
it. It is the account's root of trust.

### The two windows

`verifyStepUpToken` takes an optional provenance check from the gate and applies
it **before** the `jti` is consumed, so a refusal does not spend the caller's
single-use token, and exactly one outcome reaches
`osn.auth.step_up.verified{result}`.

Either window refuses; both are 72 hours (`RECOVERY_COOLDOWN_MS`).

| Window | Source of truth | Refuses |
|---|---|---|
| Registration provenance | `passkeys.provenance_amr` + that row's `created_at` | a credential stamped `otp`, `totp` or `recovery`, inside its own window, acting on a credential **older than or the same age as** itself, or changing the email |
| Recovery | `accounts.last_recovered_at` | an `otp`-factor step-up changing the email, and any post-recovery credential removing a pre-recovery one |

Four details that are load-bearing rather than incidental:

- **A `webauthn` token carrying no provenance claims is refused.** Only the
  signing key can mint one, so it is not an attack path — but a rule that reads
  a missing claim as "unrestricted" is one forgotten mint site away from being
  no rule at all.
- **The registration-provenance comparison is `<=` with an id guard, not `<`.**
  `passkeys.created_at` is unix **seconds**, so two credentials registered back
  to back tie and a strict comparison lets the second remove the first. The id
  guard is what still lets a credential delete itself — so the account can never
  be trapped into keeping the one a recovery enrolled.
- **The recovery window's comparison is `<`, and the asymmetry is deliberate.**
  The two windows ask different questions. Registration provenance asks "is the
  target at least as old as the credential asking" — a same-second tie means
  their ages cannot be told apart, so the older must win. The recovery window
  asks "does the target predate the recovery", and a credential stamped in the
  recovery's own second does not. Widening it to `<=` buys nothing and costs the
  owner: a target created in that second is at most a second old when the
  recovery lands, so registration provenance already refuses every
  weak-provenance credential against it, and the only asserter `<=` could newly
  refuse is a post-recovery credential carrying `webauthn` — which by the
  inheritance rule is one the owner derived from a passkey they still hold, and
  is exactly the credential that has to be able to remove what the recovery
  enrolled.
- **Rename is gated on the same comparison as delete.** It shares the
  `passkey_delete` purpose claim, and a credential the rule stops from deleting
  an older one could otherwise relabel it, which is how a user is talked into
  confirming a delete on the wrong row.

What the rule deliberately does **not** cover: `recovery_generate`,
`security_event_ack` and `totp_disable` sit outside both windows, so an attacker
holding the mailbox can still burn the owner's recovery codes, dismiss the
banner and strip TOTP during the cooldown. Gating `recovery_generate` would stop
an honest user replacing the codes a recovery just spent, which
[[musubi-identity-migration]] prescribes as the next step. Tracked privately;
the actions stay audited and notified.

## Verification

`verifyStepUpToken(token, expectedAccountId, allowedAmr, expectedPurpose?)` rejects any of:

- Bad signature / expired
- Wrong `aud`
- `sub` ≠ expected account
- `jti` already consumed
- No intersection between token `amr` and caller's allow-list
- Token `purpose` ≠ `expectedPurpose`, when the caller names one (including a token with no `purpose` at all)
- The credential-provenance rule refuses it (`result="provenance_blocked"`) — checked before the `jti` is consumed, so the token survives the refusal

Each outcome increments `osn.auth.step_up.verified{result}` with a distinct bounded label so the observability dashboard can distinguish "your ops team forgot to wire step-up through Settings" from "an attacker is trying to replay captured tokens".

## Observability

- `osn.auth.step_up.issued{factor}` — one per successful `/complete`; `factor` includes `totp`
- `osn.auth.step_up.verified{result}` — one per gated-endpoint check
- Spans: `auth.step_up.begin`, `auth.step_up.complete`
- Redaction: `stepUpToken` / `step_up_token` are in the logger deny-list

## Threat model

A stolen access token alone cannot:
- Burn existing recovery codes and lock the legitimate user out.
- Swap the account email and pivot to a permanent takeover.

The attacker must additionally compromise either a passkey (hardware-bound) or the user's verified email inbox. Combined with [[sessions]] (`Sign out everywhere else`) this gives the user a narrow, survivable window.

A stolen access token **plus** the mailbox, or plus a cloud-synced authenticator
seed, used to be enough for both: register a credential of your own and assert
it. That is what credential provenance closes, and the two limits of the closure
are worth stating rather than leaving to be discovered.

**A pre-recovery credential is the best evidence of ownership available, and it
is not always the owner's.** A user who loses an unlocked phone and recovers
cannot remove that phone's credential for 72 hours, while whoever holds the
phone can remove the newly enrolled one and change the email at once. The
asymmetry that protects the owner against a mailbox attacker points the other
way here. User verification is required at assertion, so the standing assumption
is that an unlocked device is its owner; there is no signal available that
separates the two cases.

**The "this wasn't me" lever arrives by email.** `POST /recovery/disown` is
reached from a token in the recovery notice, which goes to `accounts.email` — in
the headline threat, the attacker's inbox. It is a real lever for a TOTP
recovery with the mailbox intact, and for an owner who also reads the mail; it is
not a defence against someone who owns the inbox. What protects that owner is
the asymmetry itself.
