---
"@cire/organiser": patch
"@cire/vendor": patch
---

Collapse the portal login pages to a single "Continue with musubi" button.

Both portals offered a second door — "Create account with musubi", which added
`prompt=create` so the issuer opened on its sign-up half. Both buttons left for
the same issuer and ended in the same place, and only the issuer knows whether
this person already has an account; asking on the cire side just made cire
guess, and a wrong guess sent an existing organiser to a sign-up form. The
issuer's sign-in screen carries its own "No account yet? Create one", so nobody
is stranded — the account gets made one screen later, on the surface that owns
account creation. The button is followed by a line saying so.

`startCreateAccount()` in `@shared/rp-auth` and cire-api's `prompt=create`
allowlist are unchanged and still supported; nothing in cire calls them now.
