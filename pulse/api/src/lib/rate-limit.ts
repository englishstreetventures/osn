/**
 * Per-user write rate limiting for the authenticated Pulse write surfaces
 * (event create/update, RSVP, bulk invite, comms blast, series create/patch,
 * close-friend mutations).
 *
 * Keying is on the JWT-asserted `profileId` rather than the client IP, so
 * this layer has no dependency on the `X-Forwarded-For` trust model that
 * gates the unauthenticated reads (`/events/discover`). Every write endpoint
 * already establishes identity before mutating state, so the user id is the
 * natural and spoof-resistant throttle key.
 *
 * The backend is the same `RateLimiterBackend` abstraction used everywhere
 * in the monorepo, here the in-memory `createRateLimiter`: each process, and
 * each Worker isolate, counts on its own. `check()` may be sync or async;
 * callers `await` it.
 *
 * Fail-closed (mirrors `osn/api` graph routes + the Pulse discovery limiter):
 * a backend error is treated as "rate-limited", so a failing backend blocks
 * writes rather than silently dropping the throttle.
 */

import { createRateLimiter, type RateLimiterBackend } from "@shared/rate-limit";

import { metricWriteRateLimited, type PulseWriteEndpoint } from "../metrics";

const ONE_MINUTE_MS = 60_000;
const FIVE_MINUTES_MS = 5 * 60_000;
const ONE_HOUR_MS = 60 * 60_000;

/**
 * Limit values per write endpoint. Starting points justified inline; tuned
 * to be generous for legitimate organiser / attendee flows but tight enough
 * to make scripted abuse uneconomic. See `[[wiki/shared/rate-limiting]]`.
 */
export const PULSE_WRITE_LIMITS = {
  // Event creation is the heaviest write (insert + re-read + materialise).
  // 20 in 5 min covers a power-organiser batching a week of events without
  // letting a script spray the events table.
  event_create: { maxRequests: 20, windowMs: FIVE_MINUTES_MS },
  // Edits are cheap and legitimately bursty (drag-resize a time, fix a typo,
  // toggle visibility). 60/min matches the osn/api graph-write posture.
  event_update: { maxRequests: 60, windowMs: ONE_MINUTE_MS },
  // RSVP changes are user-initiated and idempotent; 30/min absorbs
  // double-taps and indecision without enabling counter-poisoning.
  rsvp_upsert: { maxRequests: 30, windowMs: ONE_MINUTE_MS },
  // Bulk invite is organiser-only and fans out to many rows per call
  // (capped at MAX_EVENT_GUESTS). 10/min is plenty for staged invite waves.
  event_invite: { maxRequests: 10, windowMs: ONE_MINUTE_MS },
  // Comms blasts go out over SMS/email — the most expensive, most abusable
  // write. 5/min is a hard backstop above any sane organiser cadence.
  comms_blast: { maxRequests: 5, windowMs: ONE_MINUTE_MS },
  // Series create materialises many instances; hourly window because a
  // legitimate user rarely creates more than a handful of recurring series.
  series_create: { maxRequests: 10, windowMs: ONE_HOUR_MS },
  // Series patches can re-materialise future instances; 60/hr is generous
  // for iterative editing while bounding the re-materialisation cost.
  series_update: { maxRequests: 60, windowMs: ONE_HOUR_MS },
  // Close-friend add/remove are tiny list writes; 60/min matches the
  // general graph-write posture and absorbs rapid picker toggling.
  close_friend_mutate: { maxRequests: 60, windowMs: ONE_MINUTE_MS },
} as const satisfies Record<PulseWriteEndpoint, { maxRequests: number; windowMs: number }>;

/**
 * Per-IP budgets for the unauthenticated surfaces, each over one minute. The
 * routes' default limiters and {@link makeMemoryRateLimiters} both read them.
 */
export const PULSE_IP_LIMITS = {
  // `GET /events/discover`, the most expensive Pulse read (multi-filter, bbox
  // prefilter, optional graph fetch). Matches osn-api's graph-write posture.
  discovery: { maxRequests: 60, windowMs: ONE_MINUTE_MS },
  // `POST /events/:id/share`: outbound share intents. One person fires few.
  share: { maxRequests: 60, windowMs: ONE_MINUTE_MS },
  // `POST /events/:id/exposure`: page loads through a sourced URL. Reloads,
  // link previews and bot scans all land here, so it gets more headroom.
  exposure: { maxRequests: 120, windowMs: ONE_MINUTE_MS },
  // The OIDC redirect legs (`/api/auth/oidc/start`, `/callback`). Each mints
  // a transaction or costs a token exchange; a person signs in once.
  authStart: { maxRequests: 20, windowMs: ONE_MINUTE_MS },
  // `GET /api/auth/session` and `POST /api/auth/signout`. The probe runs on
  // every page load, and a shared NAT puts many people behind one key.
  authSession: { maxRequests: 120, windowMs: ONE_MINUTE_MS },
} as const satisfies Record<string, { maxRequests: number; windowMs: number }>;

/** Build a default in-memory limiter for the given write endpoint. */
export function createDefaultWriteRateLimiter(endpoint: PulseWriteEndpoint): RateLimiterBackend {
  return createRateLimiter(PULSE_WRITE_LIMITS[endpoint]);
}

/** One per-user limiter per write endpoint. */
export type PulseWriteRateLimiters = Readonly<Record<PulseWriteEndpoint, RateLimiterBackend>>;

/**
 * Every rate limiter the Pulse app graph needs: the per-user write limiters
 * and the per-IP limiters on the unauthenticated surfaces.
 */
export interface PulseRateLimiters {
  readonly write: PulseWriteRateLimiters;
  readonly discovery: RateLimiterBackend;
  readonly share: RateLimiterBackend;
  readonly exposure: RateLimiterBackend;
  /** Redirect legs of the OIDC sign-in (`/api/auth/oidc/*`) — tight bucket. */
  readonly authStart: RateLimiterBackend;
  /** Session probe + sign-out (`/api/auth/session`, `/api/auth/signout`). */
  readonly authSession: RateLimiterBackend;
}

/**
 * A fresh set of in-memory limiters, one per endpoint, from
 * {@link PULSE_WRITE_LIMITS} and {@link PULSE_IP_LIMITS}. A refused hit is
 * not counted, and expired keys are swept once a limiter holds more than
 * 10,000 (`createRateLimiter`).
 */
export function makeMemoryRateLimiters(): PulseRateLimiters {
  const write = Object.fromEntries(
    (Object.keys(PULSE_WRITE_LIMITS) as PulseWriteEndpoint[]).map((endpoint) => [
      endpoint,
      createDefaultWriteRateLimiter(endpoint),
    ]),
  ) as Record<PulseWriteEndpoint, RateLimiterBackend>;
  return {
    write,
    discovery: createRateLimiter(PULSE_IP_LIMITS.discovery),
    share: createRateLimiter(PULSE_IP_LIMITS.share),
    exposure: createRateLimiter(PULSE_IP_LIMITS.exposure),
    authStart: createRateLimiter(PULSE_IP_LIMITS.authStart),
    authSession: createRateLimiter(PULSE_IP_LIMITS.authSession),
  };
}

/**
 * Run the per-user rate-limit check for a write endpoint. Returns `true`
 * when the request is allowed, `false` when it should be rejected with 429.
 * Fail-closed: a thrown / rejected backend check counts as rate-limited and
 * records the `pulse.write.rate_limited` counter so the deny is observable.
 */
export async function checkWriteRateLimit(
  limiter: RateLimiterBackend,
  endpoint: PulseWriteEndpoint,
  profileId: string,
): Promise<boolean> {
  let allowed: boolean;
  try {
    allowed = await limiter.check(profileId);
  } catch {
    allowed = false;
  }
  if (!allowed) metricWriteRateLimited(endpoint);
  return allowed;
}
