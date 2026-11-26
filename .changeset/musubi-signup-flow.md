---
"@osn/auth-ui": minor
"@musubi/social": patch
"@tools/lab": patch
---

Musubi's sign-up keeps what was typed across a closed dialog or a reload, says under the handle what typing does to it, refuses a date of birth in the future or more than 120 years ago with a line saying so, and holds Send for a minute after a rate limit, counting down. The passkey step names the handle the account was made under, comes back after a reload or a closed tab while the account's session lasts, and ends on a screen with a heading, a line and one action when that session has gone: Sign in, or Sign in with your new passkey once the passkey is in. `Register` takes `onSignIn` and `SignIn` takes `onCreateAccount`, and Musubi's dialogs link to each other with them, the second opening once the first has closed. `CreateProfileForm`'s handle field shows the same hint and too-long line as `Register`'s, from `@osn/auth-ui/handle-copy`. `SignIn` removes the sign-up draft and the passkey-step marker once its session is published, on every host, and `forgetEnrolling(profileId)` removes the marker only when it names that account.
