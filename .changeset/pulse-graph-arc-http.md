---
"@pulse/api": minor
"@osn/db": minor
"@osn/crypto": minor
"@osn/core": minor
---

Implement kid-based ARC key auto-rotation. Adds service_account_keys table (per-key rows, zero-downtime rotation). ArcTokenClaims now requires a kid field (JWT header). resolvePublicKey now takes (kid, issuer, scopes). pulse/api auto-rotates ephemeral keys via startKeyRotation(). Migrates pulse/api graph bridge from in-process imports to ARC-token authenticated HTTP calls against /graph/internal/* endpoints.
