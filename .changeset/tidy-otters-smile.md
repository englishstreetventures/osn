---
"@osn/social": patch
---

Serve the Apple App Site Association file from the identity apex. `musubi.social` now returns `/.well-known/apple-app-site-association` with an explicit `Content-Type: application/json`, which native apps need before a `webcredentials:` associated domain will form. The file has no extension, so without the pinned type Pages guesses and the global `nosniff` turns the guess into a silent failure — the association simply never forms and passkeys never appear.
