---
"@shared/osn-auth-client": patch
"@osn/api": patch
---

Require an `exp` claim when verifying an access or step-up token. `jose`
validates expiry only when the claim is present, so a token minted without one
verified for as long as the signing key lived — no expiry, and neither verifier
looks at token age by any other route. The issuer always sets `exp` (5 minutes
for access tokens), so requiring it rejects nothing that was ever meant to work.
