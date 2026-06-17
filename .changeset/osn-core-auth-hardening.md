---
"@osn/api": minor
"@shared/redis": patch
"@shared/observability": patch
---

OSN core auth hardening (W6):

- **O1 — issuer pinning + clock tolerance.** Access and step-up JWTs are now
  signed with `iss = AuthConfig.issuerUrl` and verified with `issuer` pinned +
  a 30s `clockTolerance` at every verify site (local signer + verifier half;
  the downstream `@shared/osn-auth-client` verifier is W7). Rollout is
  verifier-first: the tolerant verifier must deploy before the signer enforces
  `iss`.
- **O2 — recovery-code per-account lockout.** `consumeRecoveryCode` now counts
  failed attempts keyed on the RESOLVED accountId (threshold 5, 15-min
  lockout), Redis-backed with an in-memory fallback. Lockout returns the same
  generic error (no enumeration oracle), writes a `recovery_code_lockout`
  security-event row, and resets on success. Unknown identifiers never lock a
  victim.
- **O3 — full Redis ceremony-store epic.** Every process-local ceremony /
  pending-state store (registration + login + step-up challenges, pending
  registrations, step-up OTP, pending email changes, cross-device requests) now
  has an injectable Redis-backed implementation alongside the in-memory default,
  plus the two per-account caps (profile-switch, email-change-begin) routed
  through the rate-limiter family. New `RedisNamespace` metric union in
  `@shared/redis` and per-namespace store telemetry.
- **O4 — passkey-register cookieless fix.** `completePasskeyRegistration` now
  invalidates ALL account sessions (with a logged anomaly + invalidation
  metric) when no caller session is resolvable, instead of silently skipping
  H1 invalidation.
- **O5 — randomised enumeration-probe sentinels.** The fixed `acc_enum_probe` /
  `__nonexistent__` burn-in keys are now per-request random non-matching ids.

`@shared/observability` adds the `recovery_code_lockout` security-event kind.
