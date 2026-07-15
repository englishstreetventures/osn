---
"@osn/api": patch
---

Make refresh-token rotation atomic (compare-and-swap on the old session).

`refreshTokens` verified the session then deleted-old/inserted-new in a batch.
Two concurrent refreshes presenting the same token both passed verification and
both inserted a new session, leaving two live sessions in one family with reuse
detection never firing. The old-session DELETE is now the CAS gate: rotation
proceeds only while the old row still exists (rows-affected == 1); a 0-rows
result means the token was already rotated out (concurrent refresh or replay),
which is treated as C2 reuse — the whole family is revoked instead of minting a
sibling session. Mirrors the recovery-code CAS already in this file.
