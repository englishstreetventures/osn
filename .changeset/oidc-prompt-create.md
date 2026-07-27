---
"@osn/api": patch
"@osn/social": patch
"@shared/rp-auth": patch
---

Support `prompt=create` — let a relying party open the consent screen on its
sign-up half.

"Initiating User Registration via OpenID Connect 1.0". A relying party sends
`prompt=create` when it knows the visitor has no account yet; the provider then
leads with registration rather than sign-in, and the new user lands back on the
app signed in, inside the same OIDC transaction.

**`@osn/api`.** `prepareAuthorization` checks `create` before every other branch
— a signed-in visitor who clicked "create an account" meant it — and parks the
request with the same `requireAuthAfter = now` that `prompt=login` uses, so the
decision only accepts a session created after the request arrived. Registration
ends in an enrolled passkey and an adopted session, which satisfies that. The
pre-existing rule that `none` may not be combined with another value already
rejects `none`+`create`, so the branch is unreachable in silent mode.

**`@osn/social`.** `AuthorizeSignIn` now holds both halves of "who are you" and
swaps between them: a "No account yet? Create one" link under sign-in, and
Cancel back from registration. It opens on registration when the server says
`reason=create`. Without that second half a relying party's "Create account"
button was a dead end — the screen only ever offered a passkey ceremony to
someone who had no passkey. `reason` is advisory copy; the server re-derives
every requirement at decision time, so a tampered value widens nothing.

**`@shared/rp-auth`.** `signInUrl` takes an options bag, and `startCreateAccount`
is the same journey opened on the sign-up screen. Only `create` is ever passed
through.
