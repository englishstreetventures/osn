---
"@tools/e2e": patch
---

The E2E stack boots a second osn-api with the Email Verification API flag on and an issuer stand-in, and the `musubi-email-verification` flow signs up through it with a token: no email, then the passkey step. The begin budget guard counts that osn-api's begins apart.
