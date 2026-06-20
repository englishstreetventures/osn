---
"@cire/api": patch
---

Docs-only: correct a stale cire perf backlog line. cire never shipped PBKDF2 claim-code hashing — the guest claim code is a plaintext unique `families.public_id` matched by equality, defended by per-IP rate limiting + Turnstile + code entropy. Closed the aspirational "lower PBKDF2 iterations" item with the accurate design note. No code change.
