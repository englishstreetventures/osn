---
"@tools/e2e": patch
---

The organiser sign-ins send the dev secret in a form body, never a URL. `signInToCireHost` posts it to osn-api's `/dev/login/form`, and `cire-event-details` opens the form at `/dev/login?return_to=…`, types the secret and waits for the portal's own `/login` page.
