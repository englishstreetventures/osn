import { DbLive, type Db } from "@pulse/db/service";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { DEFAULT_JWKS_URL, extractClaims } from "../lib/auth";
import {
  completeOnboarding,
  getOnboardingStatus,
  type OnboardingStatus,
} from "../services/onboarding";

// ---------------------------------------------------------------------------
// Rate limiter — per-IP, scoped to the write endpoint
// ---------------------------------------------------------------------------

/**
 * Per-IP cap on `POST /me/onboarding/complete`. Onboarding is a one-time
 * flow per account; the limit only matters under abuse (mass-create
 * accounts and write completion spam). Tight enough to make abuse
 * uneconomic, loose enough that a user retrying after a blip is fine.
 */
const COMPLETE_RATE_LIMIT_MAX = 10;
const COMPLETE_RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;

export function createDefaultOnboardingCompleteRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: COMPLETE_RATE_LIMIT_MAX,
    windowMs: COMPLETE_RATE_LIMIT_WINDOW_MS,
  });
}

/**
 * Per-IP cap on `GET /me/onboarding`. Each call traverses JWT verification
 * and (on first call per profile) makes an ARC fetch + DB write to populate
 * the `pulse_profile_accounts` mapping cache. Generous enough that
 * legitimate boot-time fetches and React StrictMode double-invocation
 * aren't affected, but tight enough to deflect a malformed-token flood
 * paying the JWKS verify cost. Mirrors the discipline applied on POST and
 * matches `[[wiki/systems/rate-limiting]]`. Addresses S-M2.
 */
const STATUS_RATE_LIMIT_MAX = 60;
const STATUS_RATE_LIMIT_WINDOW_MS = 60 * 1000;

export function createDefaultOnboardingStatusRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: STATUS_RATE_LIMIT_MAX,
    windowMs: STATUS_RATE_LIMIT_WINDOW_MS,
  });
}

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

// Must be a static union of literals (not built from a runtime array) so
// Eden treaty narrows the array-element type on the client. Mirrors the
// `priceCurrencySchema` pattern in routes/events.ts. Keep in sync with
// `INTEREST_CATEGORIES` in services/onboarding.ts.
const interestLiteral = t.Union([
  t.Literal("music"),
  t.Literal("food"),
  t.Literal("sports"),
  t.Literal("arts"),
  t.Literal("tech"),
  t.Literal("community"),
  t.Literal("education"),
  t.Literal("social"),
  t.Literal("nightlife"),
  t.Literal("outdoor"),
  t.Literal("family"),
]);
const permLiteral = t.Union([
  t.Literal("granted"),
  t.Literal("denied"),
  t.Literal("prompt"),
  t.Literal("unsupported"),
]);

export interface OnboardingStatusWire {
  completedAt: string | null;
  interests: readonly string[];
  notificationsOptIn: boolean;
  eventRemindersOptIn: boolean;
  notificationsPerm: "granted" | "denied" | "prompt" | "unsupported";
  locationPerm: "granted" | "denied" | "prompt" | "unsupported";
}

const toWire = (status: OnboardingStatus): OnboardingStatusWire => ({
  completedAt: status.completedAt ? status.completedAt.toISOString() : null,
  interests: status.interests,
  notificationsOptIn: status.notificationsOptIn,
  eventRemindersOptIn: status.eventRemindersOptIn,
  notificationsPerm: status.notificationsPerm,
  locationPerm: status.locationPerm,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * Pulse first-run onboarding routes.
 *
 * Both endpoints require a valid bearer access token. Onboarding state is
 * keyed server-side by OSN accountId so a user with multiple profiles only
 * onboards once; the JWT-asserted profileId is resolved to its accountId
 * over ARC and cached locally (see `services/onboarding.ts:resolveAccountId`).
 *
 * Privacy: `accountId` is intentionally never returned to the client (see
 * `osn/api/tests/privacy.test.ts`). The wire shape only carries opt-in
 * flags, interests, and the completion timestamp.
 */
export const createOnboardingRoutes = (
  dbLayer: Layer.Layer<Db> = DbLive,
  jwksUrl: string = DEFAULT_JWKS_URL,
  _testKey?: CryptoKey,
  completeRateLimiter: RateLimiterBackend = createDefaultOnboardingCompleteRateLimiter(),
  statusRateLimiter: RateLimiterBackend = createDefaultOnboardingStatusRateLimiter(),
) =>
  new Elysia({ prefix: "/me/onboarding" })
    .get("/", async ({ headers, set }) => {
      // S-M2: per-IP throttle. The GET path runs JWT verification and may
      // populate the profile→account cache via ARC; without throttling a
      // malformed-token flood pays the JWKS verify cost on every request.
      // Fail-closed mirrors the discovery posture in `routes/events.ts`.
      const ip = getClientIp(headers);
      let allowed: boolean;
      try {
        allowed = await statusRateLimiter.check(ip);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        set.status = 429;
        return { error: "Too many requests" } as const;
      }
      const claims = await extractClaims(headers["authorization"], jwksUrl, _testKey as CryptoKey);
      if (!claims) {
        set.status = 401;
        return { message: "Unauthorized" } as const;
      }
      // Read-only and called once per session boot — short private cache
      // absorbs duplicate calls during navigation without staleness that
      // matters in practice (P-W3, mirrors close-friends list).
      set.headers["cache-control"] = "private, max-age=30";
      const result = await Effect.runPromise(
        getOnboardingStatus(claims.profileId).pipe(
          Effect.match({
            onSuccess: (status) => ({ ok: true as const, status }),
            onFailure: (e) => ({ ok: false as const, tag: e._tag }),
          }),
          Effect.provide(dbLayer),
        ),
      );
      if (!result.ok) {
        if (result.tag === "ProfileNotFoundError") {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        set.status = 503;
        return { error: "Onboarding status unavailable" } as const;
      }
      return toWire(result.status);
    })
    .post(
      "/complete",
      async ({ body, headers, set }) => {
        // Per-IP throttle: onboarding is one-time-per-account, so any IP
        // hammering this endpoint is abusive.
        const ip = getClientIp(headers);
        let allowed: boolean;
        try {
          allowed = await completeRateLimiter.check(ip);
        } catch {
          // Fail-closed — the rate limiter being unhealthy is no excuse
          // to drop throttling on a write endpoint (matches discovery).
          allowed = false;
        }
        if (!allowed) {
          set.status = 429;
          return { error: "Too many requests" } as const;
        }
        const claims = await extractClaims(
          headers["authorization"],
          jwksUrl,
          _testKey as CryptoKey,
        );
        if (!claims) {
          set.status = 401;
          return { message: "Unauthorized" } as const;
        }
        const result = await Effect.runPromise(
          completeOnboarding(claims.profileId, body).pipe(
            Effect.match({
              onSuccess: (status) => ({ ok: true as const, status }),
              onFailure: (e) => ({ ok: false as const, tag: e._tag }),
            }),
            Effect.provide(dbLayer),
          ),
        );
        if (!result.ok) {
          if (result.tag === "OnboardingValidationError") {
            set.status = 422;
            return { error: "Invalid onboarding payload" } as const;
          }
          if (result.tag === "ProfileNotFoundError") {
            set.status = 401;
            return { message: "Unauthorized" } as const;
          }
          set.status = 500;
          return { error: "Failed to complete onboarding" } as const;
        }
        return toWire(result.status);
      },
      {
        body: t.Object({
          interests: t.Array(interestLiteral, { maxItems: 8 }),
          notificationsOptIn: t.Boolean(),
          eventRemindersOptIn: t.Boolean(),
          notificationsPerm: permLiteral,
          locationPerm: permLiteral,
        }),
      },
    );

export const onboardingRoutes = createOnboardingRoutes();
