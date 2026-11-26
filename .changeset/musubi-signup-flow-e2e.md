---
"@tools/e2e": patch
---

The end-to-end API sign-up adds the account's first passkey, and two flows reload mid-sign-up: `musubi-register-retry` keeps every field across a real reload, and `musubi-passkey` reopens on "Add a passkey" after one and finishes.
