---
"@shared/observability": minor
"@osn/api": minor
---

Let an account at the passkey cap complete a recovery.

An account holding `MAX_PASSKEYS_PER_ACCOUNT` credentials that lost its last
device was unreachable: it could not enrol another, and it could not delete one
to make room, because deleting needs a WebAuthn step-up and a restricted
recovery session cannot mint a step-up at all.

An enrolment from a restricted recovery session is no longer refused at the cap,
or at any count — a count-based refusal there is an account nobody can reach
again. What keeps the count from ratcheting instead is a reclaim, one credential
above the cap, and it can only take back the slots that same recovery lent:
`recovery` provenance *and* created at or after the account's recorded recovery
instant, deleted in the same batch as the insert that replaces them.

Nothing that predates the recovery is ever taken. That bound is the point rather
than a detail: passkey provenance is stamped once and never updated, so a
credential an earlier recovery lent still reads `recovery` long after it has
become the account's real, daily device — and the cooldown puts the earliest
second recovery at the moment that credential matures. Where there is nothing of
its own to reclaim, the enrolment still happens and the account ends a credential
above the ceiling.

An ordinary enrolment at the cap is refused exactly as before, and no credential
the account established for itself can be reclaimed.

Adds the `passkey_reclaimed` security-event kind and the
`osn.auth.recovery.passkey_reclaim` counter (`headroom_used`, `reclaimed`,
`ceiling_yielded`).
