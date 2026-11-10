---
"@cire/infra": patch
"@cire/host": patch
---

The cire stack's tests follow cire host serving from its Worker: the production declaration puts `host.cireweddings.com` on the `cire-host` Worker, and the guard tests read that Worker at its production host. The organiser portal's comments say the static-asset layer serves it, its Worker or its Pages project until the host moves, and name no deploy job.
