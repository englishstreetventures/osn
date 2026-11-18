---
"@tools/e2e": patch
---

`musubi-passkey` checks the error lines and the shell's notices in Chromium: a wrong sign-up code, a rate-limited passkey sign-in, a failed profile list and a rate-limited retry of it, a page that fails to render, and the signed-out notice after a refused renewal — opened from a phone's top bar as well as the notice, and cleared by signing in again — each notice's ink measured and shot at 390 and 1440 px in both schemes (`musubiNotice`). The Turnstile stand-in's `reset` now hands back a fresh token, as Cloudflare's does.
