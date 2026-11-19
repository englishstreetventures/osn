---
"@tools/e2e": patch
---

`musubi-account-deletion` starts sign-ins from apps during the window: from Pulse signed out, Musubi's `/authorize` signs the person in and shows the deletion screen naming Pulse, issues no code, and "Back to Pulse" sends Pulse its refusal; from cire's organiser portal while signed in, the screen shows at once, and "Keep my account" carries the sign-in on to consent and into cire. A third deletion then ends that cire session before the sweep. `routeOidcLegsFrom` sends an app's OIDC legs, and the `/authorize` they lead to, from a flow's own address, and counts them.
