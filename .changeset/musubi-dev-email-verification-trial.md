---
"@musubi/social": patch
"@musubi/infra": patch
"@osn/api": patch
---

Musubi's dev tier can try the browser Email Verification API with a real Chrome: musubi social serves a second Chrome origin-trial token, for the dev zone and its subdomains, beside the production one, and the musubi stack turns `OSN_EMAIL_VERIFICATION_API` on for osn-api on stage `dev` only. Production stays off. The origin-trial test checks every token in `_headers` and fails 14 days before one expires, and the verifier sets its outcome on the `auth.email_verification.verify` span, where the dev tier's traces show it.
