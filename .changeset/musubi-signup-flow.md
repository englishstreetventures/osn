---
"@osn/auth-ui": minor
"@musubi/social": patch
"@tools/lab": patch
---

Musubi's sign-up keeps what was typed across a closed dialog or a reload, says under the handle what typing does to it, refuses a date of birth in the future or more than 120 years ago with a line saying so, and holds Send for a minute after a rate limit, counting down. The passkey step names the handle the account was made under, comes back after a reload or a closed tab while the account's session lasts, and ends on a screen whose one action is Sign in when that session has gone. `Register` takes `onSignIn` and `SignIn` takes `onCreateAccount`, and Musubi's dialogs link to each other with them. `SignIn` removes the sign-up draft and the passkey-step marker once its session is published, on every host, and `forgetEnrolling(profileId)` removes the marker only when it names that account.
