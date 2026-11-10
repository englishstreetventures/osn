---
"@cire/infra": patch
"@cire/landing": patch
---

The cire stack's tests follow cire landing serving from its Worker: the production declaration puts the apex `cireweddings.com` on the `cire-landing` Worker, and the guard tests read that Worker at the apex. The marketing site's comments say its Worker's static assets serve it, or its Pages project until the apex moves.
