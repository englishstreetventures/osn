---
"@shared/rp-auth": patch
"@shared/osn-auth-client": patch
---

`startSignIn` / `signInUrl` and `beginLogin` accept `prompt: "select_account"`, which asks the issuer to always show which account is signed in, with a way to use another.
