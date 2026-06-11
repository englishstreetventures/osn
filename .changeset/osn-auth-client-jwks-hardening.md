---
"@shared/osn-auth-client": minor
"@pulse/api": patch
---

Harden the shared OSN access-token verifier: treat expired/invalid
tokens as terminal (no JWKS refetch), negative-cache unknown kids,
coalesce concurrent JWKS fetches, and add a fetch timeout — removing a
per-request upstream-fetch amplifier on every consumer. Fold the
audience check into the single jwtVerify pass. Pulse routes now enforce
aud=osn-access (previously any OSN-issued token authenticated).
