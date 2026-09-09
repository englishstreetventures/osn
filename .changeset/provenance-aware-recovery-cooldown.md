---
"@osn/api": minor
"@osn/db": minor
"@osn/client": minor
"@shared/email": minor
"@shared/observability": minor
"@shared/redis": minor
---

Gate passkey deletion and email change on credential provenance, not on wall clock alone

A passkey registered a minute ago under an emailed code minted a step-up token indistinguishable from one the user had held for a year, so the narrow allow-lists on `passkey_delete` and `email_change` constrained only the direct path. Registering a credential and asserting it reached both gates in two hops.

`passkeys.provenance_amr` now records the effective strength of the ceremony chain behind each credential, inherited so the pivot cannot be laundered by another hop, and `accounts.last_recovered_at` opens a 72-hour window after any recovery. A credential that predates the recovery acts immediately; one the recovery produced waits. Adds `POST /recovery/disown`, the single-use "this wasn't me" lever carried by the recovery notice, which revokes the credentials that recovery enrolled, every session on the account, and the window itself.

The disown route answers the same `202` on every branch a caller without the token can reach, and a `500` on one they cannot: a database failure after the token has matched. That branch is the difference between the lever having fired and not, so it is reported rather than hidden, and the token is put back for a second attempt. A token reaches only the recovery it was minted for — a later recovery keeps its own credentials and its own window.
