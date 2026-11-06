---
"@tools/e2e": patch
---

The `musubi-passkey` flow adds an authenticator app in the Security section of Settings and removes it again, each behind a passkey step-up, with the code computed from the setup key the page shows (`totpCode` in the fixtures, on the suite clock). It then moves the page's clock past the access token's expiry and opens Security: one `/token` grant renews the token before any of the three authenticated reads leaves the page, and none is refused. It lists the connected apps and sees the empty state. Then it drops the session cookie and does it again: the refused grant is sent once, no read goes out, and the page shows the signed-out Settings note with the stored account gone.
