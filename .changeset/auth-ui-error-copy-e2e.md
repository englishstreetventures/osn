---
"@tools/e2e": patch
---

`musubi-passkey` checks the error lines and the shell's notices in Chromium: a wrong sign-up code, a rate-limited passkey sign-in, a failed profile list, a page that fails to render, and the signed-out notice after a refused renewal, each notice's ink measured and shot at 390 and 1440 px in both schemes (`musubiNotice`). The Turnstile stand-in's `reset` now hands back a fresh token, as Cloudflare's does.
