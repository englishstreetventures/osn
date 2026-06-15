---
"@cire/organiser": minor
"@osn/ui": minor
---

Organisers can now create a new OSN account directly from the cire login
page, not just sign in. `SignInPanel` toggles between the `SignIn` and
`Register` flows from `@osn/ui/auth`; a freshly-created account is signed
in immediately and lands on the dashboard. `Register` gains an optional
`onSuccess` callback (fired once the account exists and its first passkey
is enrolled) so standalone login pages can own the post-signup redirect.
