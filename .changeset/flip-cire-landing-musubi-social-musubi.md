---
"@musubi/infra": patch
"@musubi/social": patch
---

The musubi stack's tests follow musubi social serving from its Worker: the production declaration puts the apex `musubi.social` on the `osn-social` Worker, and the guard tests read that Worker at the apex. The app's `_headers` comment says the static-asset layer, not Pages, would guess the Apple app-site association file's type.
