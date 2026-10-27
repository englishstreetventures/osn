---
"@osn/api": minor
"@osn/db": minor
"@pulse/api": minor
"@pulse/web": patch
"@musubi/infra": patch
"@musubi/social": patch
"@shared/coordination": minor
"@shared/crypto": patch
"@shared/infra": patch
"@shared/observability": minor
"@shared/rate-limit": patch
---

osn-api keeps its short-lived shared state on a Cloudflare Durable Object instead of Upstash Redis, and the `@shared/redis` package is deleted.

- `@shared/coordination` (new): `CoordinationStore`, a SQLite-backed Durable Object class with one object per key — `increment`, `count`, `read`, `write`, `remove`, `claim`, `guess` (read the value and count one guess on the same record) and `take` (read the value and remove it), each atomic on its object, with expiry checked on read and an alarm that empties the object — and a typed client with a fail-closed fixed-window limiter. The client gets every object with `locationHint: "oc"`, so objects are created in Cloudflare's Oceania region. Only `read` and `count` are retried, once.
- `@osn/api`: the hour- and day-window limiters, the per-account caps, the per-account export, deletion and restore limiters, the ceremony stores, the step-up token guard and the three lockout counters run on the `COORDINATION` binding. Every one fails closed; a failed ceremony call answers 503. The graph, organisation and recommendation limiters run on two new native bindings, `RL_USER_20_60` and `RL_USER_60_60`, and the account export's per-IP guard and `GET /account/deletion-status` on `RL_AUTH_IP_30_60`. Every route factory gets the bundle's stores, not only the auth routes. A code ceremony reads its entry and counts the guess in one call, keeping the count on the entry; passkey sign-in, passkey registration and step-up by passkey read and remove their challenge in one call. A discoverable passkey sign-in's challenge carries a MAC and an expiry, so `begin` stores nothing; `challengeId` is now `options.challenge`. Independent store calls on the recovery and TOTP routes run side by side. Passkey sign-in `begin`, registration `begin` and recovery-code sign-in make the same store calls on every branch, and a lockout's audit row is written after the answer. An identifier or registration address over 255 characters is refused with 400. Rotated-session records move to D1, written in the same batch as the session that replaces them; the 6-hourly sweep deletes expired ones in chunks of 500 with a 75 ms pause between two chunks, at most `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS` chunks a run (10 when unset; staging and production set 100), and logs a warning when a run ends on a full chunk. `GET /health/coordination` writes, reads and removes a key through the store for a caller holding the `INTERNAL_SERVICE_SECRET` bearer (401 without it, 501 where it is unset), and the post-deploy smoke check asks it with that secret. The Worker's module is now `src/entry.ts`, which exports the handler and the `CoordinationStore` class. A deployed Worker without `COORDINATION`, or outside `local` without the `RL_USER_*` bindings, answers 503 on every route; a malformed `OSN_REFRESH_TOKEN_TTL` fails the boot. `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `REDIS_URL` and `REDIS_REQUIRED` are no longer read, and the dependency on `@shared/redis` is gone. The `osn.coordination.store.operations` counter is new, and so are `osn.retention.rows_deleted` and `osn.retention.cycle.duration`, one of each per sweep pass under `table`; `osn.auth.ceremony_store.entries` and `osn.auth.session.rotated_store.*` are removed.
- `@osn/db`: a `rotated_sessions` table (migration `20261026102423_rotated_sessions`).
- `@pulse/api`: every rate limiter is in memory, built from one budget table (`PULSE_WRITE_LIMITS`, `PULSE_IP_LIMITS` in `src/lib/rate-limit.ts`). `REDIS_URL` and `REDIS_REQUIRED` are no longer read, and the dependency on `@shared/redis` is gone.
- `@shared/observability`: the `RotatedStoreAction`, `RotatedStoreResult` and `RotatedStoreBackend` metric attribute types are removed.
- `@musubi/infra`: osn-api's dev Worker binds `COORDINATION` and the two per-user rate limits, and is bundled from `osn/api/src/entry.ts`. Dev leaves `OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS` unset, as the parity and reads checks record.
- `@shared/infra`: osn-api's secret inventory no longer lists the Upstash secrets, and the workflow check lets osn-api's dev smoke check read `INTERNAL_SERVICE_SECRET`.
- `@musubi/social`, `@pulse/web`: the privacy page names Cloudflare, not Upstash, for rate-limit state. Musubi's names Oceania, where Cloudflare hosts the databases and supporting infrastructure, rather than Australia and Sydney.
- `@shared/crypto`, `@shared/rate-limit`: comments only.
