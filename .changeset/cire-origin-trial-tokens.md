---
"@cire/build-tools": patch
"@cire/invites": patch
"@cire/host": patch
"@cire/envelope": patch
"@tools/e2e": patch
---

Chrome origin-trial tokens for `cireweddings.com`. Every server-rendered
guest-site response carries the `HTMLInCanvas` token, so the invite envelope
runs in stable Chrome without a flag; the organiser portal carries the `WebMCP`
token on every path. `@cire/build-tools/origin-trial` holds the tokens and a
decoder, and its tests fail within 14 days of a token's expiry. The notes that
said Chrome 157 turns HTML-in-Canvas on now say the date is not confirmed.
