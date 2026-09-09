---
"@shared/observability": minor
"@shared/email": minor
"@shared/redis": minor
"@osn/client": minor
"@osn/api": minor
---

Email and TOTP account recovery routes

The three public endpoints that let a locked-out user back in, each ending in the
restricted recovery session the audience work built:
`POST /login/recovery/email/{begin,complete}` and
`POST /login/recovery/totp/complete`. Neither factor is a login factor and
neither mints an ordinary session — both produce an `osn-recovery` token that
can enrol a passkey and nothing else, and enrolling one is what lifts the
restriction.

`begin` takes an **email address, not a handle**. `/login/passkey/begin` accepts
a handle because it sends nothing; this endpoint puts mail in somebody's inbox,
and a handle is public, so accepting one would turn a public identifier into a
way to mail a stranger. The check is syntactic and never touches the database,
so refusing a handle discloses nothing.

**A uniform 202 is not enough, because the send is the oracle.** Every existing
OTP send awaits the provider, and a Resend round trip is hundreds of
milliseconds against a sub-millisecond database probe — so response latency
separates a resolving identifier from a non-resolving one however identical the
body is. The send is dispatched detached with a timeout, and the non-resolving
branch makes the same number of store round trips, so both return at probe cost.
A test parks the transport on a gate, asserts the response returns anyway, then
releases it and asserts the mail actually went — the second half is what stops a
fibre that never runs from passing like one that works.

**And closing that at `begin` alone would only move it to `complete`.** `begin`
answers 202 either way but parks a code only for an address that resolves, so
the attack is two calls: `begin` for a candidate address, then `complete` with a
wrong code, timed. Every store here is an HTTP hop to Upstash in each tier but
`local`, so a branch that makes two hops answers measurably sooner than one that
makes four. All three routes therefore pin a fixed count on every branch —
`begin` two, `/login/recovery/email/complete` four, and
`/login/recovery/totp/complete` whatever `checkTotpCode` costs — padded to the
costliest real branch rather than the cheapest, since padding down is the same
oracle upside down. The TOTP route matters most: it takes an email address as
readily as a handle, so a cheap non-resolving branch there lets a stranger ask
whether an address has an OSN account at all. Its padding lives beside
`checkTotpCode` as `burnTotpCheckCost`, so a round trip added to one is added
where the other will be read. The padding is reads even where it stands in for a
write — what a caller can time is the number of hops, and a probe write would
leave a counter key behind per request. Wall-clock assertions would be flaky and
would pin nothing against an in-memory store, so the guard counts calls: the
stores are wrapped and every branch is asserted to make the same number.

**The recipient is the victim**, so the flood control is per resolved account (3
per 24 h) as well as per IP: the address is the account holder's own, a rotating
fleet already defeats per-IP keys at this issuer, and an endpoint that trains a
user to expect unsolicited recovery mail is doing a phisher's groundwork. The
cap is keyed on the resolved `accountId` and never on the submitted identifier,
or it would double as an existence oracle, and a capped call returns without
parking a code — replacing the code the user is holding would be a denial of
service dressed as flood control.

Completion matches `consumeRecoveryCode` rather than inventing a second, quieter
ceremony: every session on the account is revoked and an `account_recovered`
audit row is written in the same batch, before the new session exists, and a
`recovery-used` notice is detached afterwards.

Two things beyond the issue, both found by attacking the plan before writing it:

- **The TOTP lockout counter is now scoped by ceremony.** `checkTotpCode` is
  shared with `POST /step-up/totp/complete`, which is authenticated; the new
  recovery route is not, and it accepts a public handle. On a shared counter,
  five requests from anyone who knew a handle would have locked that account's
  step-up for fifteen minutes — taking `passkey_register`, `recovery_generate`,
  `totp_enroll`, `totp_disable`, `account_delete` and `account_export` with it
  for any user whose only non-passkey factor is TOTP — repeatedly and
  indefinitely. `checkTotpCode` now takes a required `scope` and keys the two
  surfaces apart; the lockout metric gains a bounded `scope` attribute so a
  dashboard can tell which surface is under attack.
- **A failed `complete` with no pending code does not move the lockout
  counter.** It is not a guess against anything, and counting it would hand
  anyone who knows the identifier a lever to lock the owner out of their own
  recovery without ever trying a digit.

`AuthMethod` gains `email_recovery` and `totp_recovery`. That union is pinned by
a test whose whole purpose is to stop OTP primary login creeping back, so the
pin now carries the argument rather than just the members: what separates these
from the factor `[[passkey-primary]]` removed is not the name but the audience —
a restricted session refused by all seven verifiers, accepted by one resolver,
and dead in fifteen minutes.
