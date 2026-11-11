---
title: Step-up (sudo) tokens
tags: [systems, auth, security]
related:
  - "[[identity-model]]"
  - "[[totp]]"
  - "[[recovery-codes]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
  - "[[email-links]]"
last-reviewed: 2026-11-12
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
| `POST /account/email/:requestId/complete` | `emailChangeAllowedAmr` (`context.ts`) — the one set with no `AuthConfig` field | yes | yes | **no** |

The `otp` column is the emailed factor: a link to the account's own address
([[email-links#Step-up]]). The AMR value keeps the name `otp` because
`passkeys.provenance_amr` rows store it (see Credential provenance below);
renaming it would need a data migration for no change in meaning.

Two rows are deliberately narrower than the rest, and both would be easy to
widen by accident:

- **`passkeyDeleteAllowedAmr` stays `["webauthn"]`.** By construction the caller
  already holds a passkey — the last-passkey guard fires otherwise — so
  requiring one costs nothing.
- **Email change keeps a set of its own, and no knob reaches it.** Its `otp` arm
  proves control of the **current** mailbox; a TOTP seed does not. Email change
  is the pivot to permanent takeover, so it is the one gate where the two
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
> `email_change` the second factor is a link to the **new** address, which the
> caller chose — `POST /account/email/begin` asks for no step-up, only an
> access token and a live session — so the mailbox proof the narrow list was
> written for is not proof of the *current* mailbox once the AMR arrived this
> way.
>
> This is open to `otp` as much as to `totp`, and predates both TOTP and this
> table. Closing it needs credential provenance — the AMR a passkey was
> registered under, and a cool-down on `passkey_delete` and `email_change` for
> one enrolled under a weaker factor. That is `englishstreetventures/osn#952`; the
> walk-through is in [[totp#Threat model]].

Everywhere else, `totp` is admitted precisely where the emailed link already is.

The caller presents the token either as an `X-Step-Up-Token` header or a `step_up_token` body field (email change uses body-only).

## Ceremony

Three factors — a passkey, a link emailed to the account's own address and an authenticator app — each authenticated via the caller's existing Bearer access token:

| Route | Purpose |
|---|---|
| `POST /step-up/passkey/begin` | WebAuthn assertion options, scoped to the caller's account |
| `POST /step-up/passkey/complete` | Verifies signed assertion, returns `{ step_up_token, expires_in }` |
| `POST /step-up/email/begin` | `{ purpose }`: mails a link to the account's own address for that purpose; answers `{ requestId, claimSecret, pairingCode, expiresAt }` |
| `POST /step-up/email/:requestId/status` | `{ claimSecret }`: `pending`, `expired`, or, once the link is confirmed with the typed number, `complete` with `{ step_up_token, expires_in }` — once |
| `POST /step-up/email/:requestId/resend` | Another link for the same request |
| `POST /step-up/totp/complete` | Verifies a code from the account's authenticator app, returns `{ step_up_token, expires_in }` |

**Every ceremony route needs a live session.** Each route in the table
refuses a caller whose session has ended with `409 { error: "session_stale" }`
before it writes a challenge, opens, reads or resends a link request, checks a
code or mints a token. The caller's session cookie, or its access token's
`osn_sid` binding, must name an unrestricted, unexpired session of the account
([[sessions#Access-token session binding (`osn_sid`)]]). An access token
outlives its session by up to five minutes; in that window it can mint no
step-up token, overwrite no parked passkey challenge, mail the owner nothing
and spend none of the account's daily step-up links. `POST /recovery/generate`,
email change's complete, `POST /totp/enroll/begin` and passkey registration's
begin check the session again when they spend a step-up token, and
`DELETE /passkeys/:id` checks it through `classifyCallerSession`. The other
gates, `PATCH /passkeys/:id` among them, rely on the check at the mint, so a
token minted while the session was live works there for its own five minutes.

The emailed link signs nobody in: the page it opens confirms the request, and
only the tab that began, signed in as the same account and holding the claim
secret, receives the token. The link's reader types the number that tab shows,
so a blind guess is right one time in a hundred; a wrong one ends the request
and counts toward a per-account lockout, whose fifth wrong number writes a
`step_up_link_lockout` security event. A reader who did not ask can say so
("I didn't ask for this"): that writes a `step_up_link_declined` security
event, which the account's other devices show in the security banner, since
it means someone signed in to the account asked to act and the owner said no.
No notice is mailed. The whole contract is in [[email-links#Step-up]].

TOTP has **no `begin`**: it is challenge-free, so there is nothing to mint, park
or send. Whether the factor is available is what `GET /totp/status` answers. A
TOTP code is single-use per RFC 6238 §5.2 and the step it matched is recorded
against the credential — see [[totp]].

## Purpose binding

An amr-only check says *how* the user proved themselves, not *what for*. Without more, a token minted to confirm an email change can be replayed against any other gate on the same allow-list — a confused deputy. So `/step-up/{passkey,totp}/complete` accept an optional `purpose`, and `/step-up/email/begin` requires one, fixed when the link is sent; it is stamped into the token as a `purpose` claim, and a gate that names a purpose refuses every token minted for a different one (`result="wrong_purpose"`).

| Value | Gate |
|---|---|
| `recovery_generate` | `POST /recovery/generate` |
| `account_delete` | account deletion |
| `account_export` | account export |
| `pulse_app_delete`, `zap_app_delete` | downstream app-data deletion, via `verifyStepUpForExternalPurpose` |
| `passkey_register` | `POST /passkey/register/{begin,complete}` past the first credential |
| `passkey_delete` | `DELETE /passkeys/:id` **and** `PATCH /passkeys/:id` — rename shares the claim |
| `email_change` | `POST /account/email/:requestId/complete` |
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
- **jti** — single-use replay guard. Backed by a `StepUpJtiStore` interface (see `osn/api/src/services/auth/stores.ts`) with two implementations: an in-memory Map for the Bun dev server and tests, and `createDurableJtiStore` (`osn/api/src/lib/coordination/durable.ts`) on the coordination store, where the first `claim` of a token id wins in every isolate ([[coordination-store]]). It fails closed: a guard that cannot be reached refuses the token as "Step-up token could not be verified", and the refusal is not counted as a replay — a replay guard that is unreachable counts as a ceremony no one completed.

TTL: 5 minutes. A used token's id stays claimed for the token's life, plus the
verifier's 30-second tolerance past `exp` (`JWT_CLOCK_TOLERANCE_S`, beside
`verifyJwt`), plus a minute (`STEP_UP_CLAIM_MARGIN_MS`), counted from its use —
six and a half minutes — so the claim outlives every moment the token still
verifies, whatever the verifying isolate's clock or the store's says.

## Credential provenance

`amr: ["webauthn"]` says a WebAuthn ceremony happened. It does not say whether
the credential behind it was one the user has held for a year or one registered
a minute ago under an emailed link — and for two gates that difference is the
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
reason a user adds a device by email is that the first one is hard to reach.

**Bootstrap is `webauthn`.** The account's first passkey follows a sign-up
proved by an emailed link, so a literal reading would stamp it `otp` — and through
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

### The passkey ceiling's reclaim is not a way around W1

An enrolment from a restricted recovery session above
`RECOVERY_ENROLMENT_PASSKEY_CEILING` deletes a credential to pay for its slot,
and that credential is inside its own W1 window. That is not a hole in the rule,
because the two govern different things: W1 decides what a caller may do *with a
step-up token it holds*, and the reclaim mints and presents no token at all. It
is a server-side consequence of an enrolment the account is entitled to make, on
the narrowest possible set of rows.

Three bounds keep it there, and all three are what stop it becoming a deletion
primitive:

- **Only `recovery` provenance is reclaimable.** Not `otp`, not `totp`, not
  `webauthn`, not a NULL column. Nothing the account established for itself can
  be taken.
- **Only what this recovery episode lent** — `created_at >=`
  `accounts.last_recovered_at`. Nothing that predates the recovery, whatever its
  provenance says.
- **Only above the ceiling.** At or below it nothing is destroyed.

**The matured lone row is the case the second bound exists for**, and it deserves
spelling out because it is the one that actually occurs. `provenance_amr` is
stamped at insert and never updated, so a credential the last recovery lent still
reads `recovery` a year later, when its W1 window is long gone and it is the
owner's daily phone. The cooldown then guarantees the worst pairing: it stamps
`last_recovered_at` at the instant that credential is created, so the earliest
permitted second recovery is the moment that credential matures. A rule that
selected on provenance and recency alone would therefore meet exactly one
candidate in the ordinary case — the matured one — and take it, on a path where
no step-up was presented anywhere and the notice goes to the mailbox.

So a matured row is never a candidate, and when it is the only one there is
**nothing to take**. The threshold gives way instead: the enrolment happens and
the account ends a credential above the ceiling. Refusing would put the account
back where `englishstreetventures/osn#970` found it.

See [[account-recovery-factors#E. The passkey ceiling, and the slot it lends]].

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
- Spans: `auth.step_up.begin`, `auth.step_up.resend`, `auth.step_up.complete`, `auth.step_up.email_status`, `auth.step_up.link_send`
- `osn.auth.email_link.sends{flow="step_up", result}` — step-up links sent, held back or failed
- `osn.auth.step_up.lockout{result}` — wrong typed numbers on step-up links: `recorded`, `locked` (the count at or past five, or a right number refused while it holds), `unavailable` (the counter could not be read or written)
- `osn.auth.security_event.recorded{kind}` — `step_up_link_declined` and `step_up_link_lockout` among its kinds, written after the answer (span `auth.email_link.event`)
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

**A completed email change mails the address it replaced.** The commit writes an
`email_changed` security event in the same batch as the change, and the notice
(`email-changed`, [[email]]) goes to the previous address once the change is on
record. No step-up factor can acknowledge the `email_changed` row for 7 days
after the change (`EMAIL_CHANGE_ACK_HOLD_SECONDS`, the change cap's window): an
emailed link now goes to the new address, so for that week the row stays on the
banner whoever holds it. Acknowledging it alone answers 403
`email_change_held` with `holdEndsAt`; `ack-all` acknowledges every other row and
leaves it. After the week it is acknowledged through the same gate as every other
kind (`recoveryGenerateAllowedAmr`). The notice is sent once, best effort: a send
that fails is counted (`osn.auth.security_event.notified`, `result: failed`) and
not retried.
