---
"@osn/api": patch
"@osn/db": patch
"@pulse/api": patch
"@shared/crypto": patch
"@shared/observability": patch
---

TODO-backlog hardening sweep:

- **S-H (arc-scope-pattern)** — `@shared/crypto` `SCOPE_PATTERN` rejected hyphens, so every ARC token minted with the deployed hyphenated scopes (`step-up:verify`, `app-enrollment:write`) threw `Invalid scope format` at sign time — the Flow B leave-Pulse fan-out was broken end-to-end. Pattern now admits `-`; regression-tested round-trip.
- **S-H1 (arc-key-scopes, prep-pr review) — mitigation** — osn-api stores `allowedScopes` per SERVICE (upsert = full replace) while pulse-api registers TWO keys under one serviceId; disjoint scope sets clobbered each other on every boot race / 24h rotation, randomly fail-closing either the graph bridge or Flow B. Both pulse registrations (graphBridge + outbound-arc) and the seed now carry the identical four-scope union, and the false "per-key isolation" comment is corrected. Real per-key scope storage is tracked in wiki/TODO.md.
- **S-L1 (prep-pr review)** — osn-api's `requireArc` early exits (malformed token, unknown/revoked kid, registry scope denial) now record the shared `arc.token.verification` counter, mirroring the pulse receiver; infra (DB-query) failures are excluded from the counter.
- **S-M1 (pulse-onboarding)** — dedicated `graph:resolve-account` ARC scope gates `GET /graph/internal/profile-account` (least privilege on the profileId → accountId lookup). Granted to pulse-api (self-registration + seed) and cire-api (runbook); a `graph:read`-only token now gets 401 on that endpoint.
- **S-L6 (account-deletion)** — Pulse `requireArc` now records the shared `arc.token.verification` counter on its early-exit branches (malformed / kid-unknown / kid-revoked / registry-scope-denied); new bounded `revoked_key` result value in `@shared/observability`.
- **S-M4 (auth)** — `loadJwtKeyPair` asserts the imported `OSN_JWT_PRIVATE_KEY` carries the `sign` usage, failing at boot when the public JWK is pasted into the private slot.
- **S-L5 (auth)** — boot-time assertion that `OSN_ORIGIN` is set in non-local envs (mirrors the CORS fail-closed guard) instead of silently falling back to the localhost WebAuthn origin.
- **M3 (Copenhagen)** — `EmailSchema` caps emails at 255 chars.
- **Dead metric cleanup (pulse)** — `pulse.auth.jwks_cache.lookups` deleted (cache moved to `@shared/osn-auth-client`, uninstrumented); `pulse.events.create.duration` wired around `createEvent` via `withEventCreateDuration`; `pulse.events.host_cancelled.hard_delete` wired into `runEventCancellationSweep`.
