---
"@tools/e2e": patch
---

The `musubi-passkey` flow moves the page's clock past the access token's expiry and opens Settings → Security: one `/token` grant renews the token before any of the three authenticated reads leaves the page, and none is refused. It then drops the session cookie and does it again: the refused grant is sent once, no read goes out, and the page shows the signed-out Settings note with the stored account gone.
