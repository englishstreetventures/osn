---
"@pulse/api": minor
---

Harden the Pulse API write surface (W4):

- **Per-user write rate limiting** on every authenticated write endpoint —
  event create (20/5min), update (60/min), RSVP (30/min), bulk invite (10/min),
  comms blast (5/min), series create (10/hr) + patch (60/hr), and close-friend
  mutations (60/min). Keyed on `claims.profileId` (not IP) and fail-closed: a
  backend error is treated as rate-limited. Rejections record the new
  `pulse.write.rate_limited` counter.
- **Redis composition root** (`src/redis.ts` + `src/lib/redis-rate-limiters.ts`)
  mirroring osn/api: Redis-backed limiters when `REDIS_URL` is set, in-memory
  fallback for local/test. Same env-driven selection + fail-closed-on-required
  behaviour.
- **CORS allowlist** replaces the bare `cors()` wildcard. Origins come from
  `PULSE_CORS_ORIGIN`; non-local envs fail closed if it is unset, local dev
  falls back to the Tauri dev port (1420).
- **Attendee visibility flag**: a new `canViewAttendees` policy
  (`services/eventAccess.ts`) is surfaced as an additive, non-breaking boolean
  on the `GET /events/:id/rsvps` and `/rsvps/latest` responses (organiser-only
  today; the organiser-only payload cutover is deferred).

Minor (not patch): the additive `canViewAttendees` response field is a new
wire surface that Eden-treaty clients pick up.
