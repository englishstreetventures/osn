---
"@osn/db": minor
"@osn/api": minor
---

The `osn-recovery` token audience, for restricted recovery sessions

Account recovery has to end in a session that can enrol a fresh passkey and do
nothing else. This adds that primitive. **No route mints one yet** — the
recovery endpoints are separate work, and the tests are this change's reader.

The restriction is a distinct access-token audience, `osn-recovery`, not a
column. There is no single guard a column could be checked in: four entry points
in osn-api verify access tokens, and `pulse/api`, `zap/api` and `cire/api` verify
the same token over JWKS with no access to OSN's database. All seven already pin
`osn-access`, so all seven reject the new audience with **no change to any of
them** — fail-closed by construction, and not waiting on three other services to
deploy. `resolvePasskeyEnrollPrincipal` is the only resolver taught to accept it,
which makes `/passkey/register/begin` and `/complete` the only two routes it
reaches.

`sessions.restricted_until` (new column, migration `0008`) is the source of truth
for **rotation**, not for request-time authorisation: `refreshTokens` copies it
forward and re-mints on the recovery audience, or the restriction would die on
the first silent refresh five minutes in. It also pins an absolute 15-minute
expiry that never slides — and that guard has to be explicit, because a
restricted session's whole life sits inside half of a 30-day TTL, so the sliding
window's own condition is always true for exactly the session that must expire on
schedule. `completePasskeyRegistration` clears the column and restores an
ordinary TTL, which is what lifts the restriction.

A recovery-audience caller **bypasses the passkey step-up gate**, deliberately:
losing a phone does not delete its passkey row, so the gate would otherwise block
the common recovery case. The alternative — letting a restricted session mint
step-up tokens — would hand it `/recovery/generate`, `DELETE /account`,
`GET /account/export` and `/account/email/complete` as well.

That bypass is the one grant of privilege here, and it is priced rather than
assumed. `issueRecoverySession` takes a **required** `amr` — `"otp"`, `"totp"` or
`"webauthn"` — refuses at mint time anything `passkeyRegisterAllowedAmr` does not
admit, and records it in `sessions.restricted_amr` (new column, migration
`0009`), which rotation carries forward alongside the deadline.
`beginPasskeyRegistration` reads that column back off the caller's own session
row, so its `caller` argument is now the session's hash
(`{ recoverySessionHash }`) rather than a boolean the route asserted from the
token's audience: no route can mint a session whose factor the gate would have
refused, and narrowing the allow-list withdraws the bypass from sessions already
issued.

Two predicates were added to the write that lifts the restriction, which is the
one place a restricted session becomes a full one. It is now scoped to the
caller's `account_id`, like the two sibling session writes that take the same
server-derived hash, and to `expires_at > now` — `liveSessionIds` has no expiry
term, so an expired restricted row still classified as the caller's own and
enrolment converted it into an ordinary 30-day session, making the real bound the
15-minute deadline plus one access-token TTL rather than 15 minutes.

Two behaviour changes beyond the issue, both closing ways the restriction would
have failed open:

- `verifyRefreshToken` now **rejects a restricted session unless the caller opts
  in**, and `refreshTokens` is the only caller that does. `GET /authorize`
  resolves the signed-in user from the session cookie rather than an access
  token, so without this a recovery session would have completed an OIDC
  authorization and signed the user into every relying party.
- `ACCESS_TOKEN_AUDIENCE` moves into `constants.ts` beside the new one, and the
  reserved OIDC client-id deny-list references both by name instead of repeating
  the literals — the deny-list can no longer drift from the audiences it guards.
