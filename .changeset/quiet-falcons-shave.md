---
"@osn/api": patch
"@pulse/api": patch
"@shared/crypto": patch
"@shared/osn-auth-client": patch
"@zap/api": patch
---

Take jose 6.2.10 (from 6.2.4). Releases 6.2.5 through 6.2.10 are all JOSE and JWT input-validation hardening: reject characters outside the Base64URL alphabet, reject invalid UTF-8 in JOSE headers and JWT claims sets, reject truncated ASN.1 key data, reject duplicate `crit` values, reject an unencoded payload in the JWS Compact Serialization, compare claim values correctly for falsy validation options, and enforce verification key metadata from a JWKS. jose sits under both the ARC service-to-service tokens and the five-minute osn-access JWTs, so this is parser hardening on the two token types where it matters most. No API change; the tightening only narrows what parses.
