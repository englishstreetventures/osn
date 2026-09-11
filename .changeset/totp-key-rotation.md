---
"@osn/api": minor
"@shared/observability": patch
"@osn/db": patch
---

`OSN_TOTP_ENCRYPTION_KEY` can now be rotated without every enrolled user
re-enrolling their authenticator.

osn-api holds the key as a version-to-key ring built from `OSN_TOTP_ENCRYPTION_KEY`
and a new optional `OSN_TOTP_ENCRYPTION_KEY_PREVIOUS`. New ciphertext is written
under the highest version present, and each successful code check re-encrypts its
own row under the current key — inside the same conditional UPDATE that consumes
the RFC 6238 step, so single use is unchanged and no read-then-write is
introduced. The outgoing key drains as people use their second factor: no bulk
job, no downtime. A re-encryption that fails never fails the verify; the row
stays where it is and the next check tries again.

A row's `key_version` is a hint rather than a lookup key. Decryption tries every
configured key and takes whichever opens the row, because a rotation stages its
two Worker secrets some time apart and in that window a row's stamp and the key
it is really under disagree — selecting on the stamp would refuse those rows, and
a row rewritten during the disagreement could never be opened again. Trial
decryption is sound because AES-GCM authenticates, and the accountId is still
bound in as additional authenticated data on every attempt, so a row copied onto
another account opens under nothing.

A credential no configured key can open is now the same generic failure as a
wrong code rather than a 500, closing an oracle that told an unauthenticated
caller at `POST /login/recovery/totp/complete` whether an account had a second
factor at all. It is counted as `osn.auth.totp.verified{result="unreadable"}`,
alongside a new `osn.auth.totp.rekeyed{result}` counter for the drain.

Booting with only `OSN_TOTP_ENCRYPTION_KEY` set behaves exactly as before. The
previous-key secret is optional in every tier, but not lenient: present and
malformed fails the boot, as the current key does.
