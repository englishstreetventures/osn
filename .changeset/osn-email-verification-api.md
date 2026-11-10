---
"@osn/api": minor
"@osn/client": minor
"@osn/auth-ui": minor
"@shared/observability": minor
---

Sign-up can accept a browser Email Verification API token, behind the osn-api flag `OSN_EMAIL_VERIFICATION_API` (off unless it reads true). With it on, `POST /register/email-verification-nonce` hands the sign-up form a nonce, `Register` adds the hidden `email-verification-token` field, and a begin whose token verifies confirms a free address at once: no email, no number to match, and the first status poll makes the account before the passkey step. A taken or held address, and every refused token, takes the emailed link path unchanged. `@osn/client` gains `emailVerificationNonce()` and the begin fields `emailVerificationToken` and `nonceSecret`; `@shared/observability` gains `EmailVerificationTokenOutcome` and redacts both fields.
