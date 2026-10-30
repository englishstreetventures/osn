---
"@osn/api": patch
"@osn/db": minor
---

Session revoke, consent re-grant, passkey counters and erasure cancel hold against a request that lands between their read and their write.

- `DELETE /sessions/:id` revokes the device: every session in the family of the session its handle names, in one statement. A handle the device has since refreshed past still finds its family, through the rotation records. A refresh rotation inserts the new session (copying the device and any restriction from the old row as it stands) before it deletes the old one, so a revoke, a reuse revoke or any account-wide sign-out that lands mid-rotation leaves no session behind it. A failed rotation keeps the old session. A grant that loses its swap removes what it wrote and answers the race message, as a concurrent grant does.
- Re-approving an OIDC consent writes the merged scope only while the consent is as it was read. A revoke landing in between makes the approval start from exactly the scope it approved, never the withdrawn one; a second change in that window fails the approval with a 500 and writes nothing.
- A passkey assertion's counter is written only while the stored counter still lets it through (below the new one, or both 0). Of two assertions verified against one counter, the second to write is refused with `Passkey verification failed` at sign-in and at step-up, as it is when they arrive in turn; a passkey deleted between the read and the write is refused too.
- `deletion_jobs` gains `purge_started_at` (migration `20261030093003_deletion_job_purge_claim`). The fan-out and hard-delete sweeps stamp it before they purge anything; `POST /account/restore` cancels only while it is unset and the grace window is open, in the same statement, and answers `{ cancelled: false }` otherwise. A cancel that lands first leaves the sweep nothing to purge.
