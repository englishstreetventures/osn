---
"@osn/api": patch
---

The service-account key routes report what they did: revoke answers 404 for an unknown key id and `alreadyRevoked` for a repeat, and register answers 409 `kid_revoked` for a revoked key id.
