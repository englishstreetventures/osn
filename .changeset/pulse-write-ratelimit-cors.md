---
"@pulse/api": minor
---

Harden the Pulse API write + share surface (W4):

- **Per-user write rate limiting** on every authenticated write endpoint —
  event create (20/5min), update (60/min), RSVP (30/min), bulk invite (10/min),
  comms blast (5/min), series create (10/hr) + patch (60/hr), and close-friend
  mutations (60/min). Keyed on `claims.profileId` (not IP) and fail-closed: a
  backend error is treated as rate-limited. Rejections record the new
  `pulse.write.rate_limited` counter.
- **Redis composition root** (`src/redis.ts` + `src/lib/redis-rate-limiters.ts`)
  mirroring osn/api: Redis-backed limiters when `REDIS_URL` is set, in-memory
  fallback for local/test. Same env-driven selection + fail-closed-on-required
  behaviour. Covers the per-user write limiters plus the per-IP discover /
  share / exposure limiters.
- **CORS allowlist** replaces the bare `cors()` wildcard. Origins come from
  `PULSE_CORS_ORIGIN`; non-local envs fail closed if it is unset, local dev
  falls back to the Tauri dev port (1420).
- **Hardened per-IP limiting on the share-attribution surface**
  (`POST /events/:id/share` + `/exposure`) and `/events/discover`: the keying
  IP is now resolved via the spoofing-resistant `getClientIp(headers, options)`
  trust policy (`PULSE_TRUSTED_PROXY_COUNT`, or `trustCloudflare` behind CF).
  An unresolved IP fails closed (429) instead of sharing a single `unknown`
  bucket. (An HMAC-signed share token to bind the share/exposure ping to a
  real share event remains a deferred follow-up.)
- **Attendee visibility flag**: a new `canViewAttendees` policy
  (`services/eventAccess.ts`) is surfaced as an additive, non-breaking boolean
  on the `GET /events/:id/rsvps` and `/rsvps/latest` responses (organiser-only
  today; the organiser-only payload cutover is deferred).

Minor (not patch): the additive `canViewAttendees` response field is a new
wire surface that Eden-treaty clients pick up.
