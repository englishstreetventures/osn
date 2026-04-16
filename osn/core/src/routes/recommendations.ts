import { DbLive, type Db } from "@osn/db/service";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { createRateLimiter, type RateLimiterBackend } from "../lib/rate-limit";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createRecommendationService } from "../services/recommendations";

// ---------------------------------------------------------------------------
// Rate limiter — per-user fixed window
//
// Recommendations requests each run a FOF fan-out query that can return many
// rows; tighter budget than graph/org writes to limit DoS and graph-inference
// enumeration (S-H1).
// ---------------------------------------------------------------------------

const RECOMMENDATIONS_RATE_LIMIT_MAX = 20;
const RECOMMENDATIONS_RATE_LIMIT_WINDOW_MS = 60_000;

/** Default in-memory recommendations rate limiter. Override for Redis. */
export function createDefaultRecommendationRateLimiter(): RateLimiterBackend {
  return createRateLimiter({
    maxRequests: RECOMMENDATIONS_RATE_LIMIT_MAX,
    windowMs: RECOMMENDATIONS_RATE_LIMIT_WINDOW_MS,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Recommendation routes
// ---------------------------------------------------------------------------

export function createRecommendationRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  /** See `createAuthRoutes` — same semantics. */
  loggerLayer: Layer.Layer<never> = Layer.empty,
  /**
   * Per-user rate limiter for the (expensive) FOF fan-out read. Supply a
   * Redis-backed backend in production via `createRedisRecommendationRateLimiter`.
   */
  rateLimiter: RateLimiterBackend = createDefaultRecommendationRateLimiter(),
) {
  if (typeof rateLimiter?.check !== "function") {
    throw new Error("Recommendations rateLimiter must have a check() method");
  }

  const auth = createAuthService(authConfig);
  const recommendations = createRecommendationService();

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  async function requireAuth(
    authorization: string | undefined,
    set: { status?: number | string },
  ): Promise<{ profileId: string; handle: string } | null> {
    const token = extractToken(authorization);
    if (!token) {
      set.status = 401;
      return null;
    }
    try {
      return await Effect.runPromise(Effect.orDie(auth.verifyAccessToken(token)));
    } catch {
      set.status = 401;
      return null;
    }
  }

  // Fail-closed: if the limiter backend rejects, treat as limited.
  async function requireRateLimit(
    profileId: string,
    set: { status?: number | string },
  ): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await rateLimiter.check(profileId);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      set.status = 429;
      return false;
    }
    return true;
  }

  return new Elysia({ prefix: "/recommendations" }).get(
    "/connections",
    async ({ query, headers, set }) => {
      const caller = await requireAuth(headers.authorization, set);
      if (!caller) return { error: "Unauthorized" };
      if (!(await requireRateLimit(caller.profileId, set))) {
        return { error: "Rate limit exceeded" };
      }
      try {
        // Schema guarantees limit is a finite integer in [1, 50] when present.
        const limit = query.limit ?? 10;
        const suggestions = await run(recommendations.suggestConnections(caller.profileId, limit));
        return { suggestions };
      } catch {
        set.status = 500;
        return { error: "Request failed" };
      }
    },
    {
      query: t.Object({
        // Elysia's t.Numeric coerces the string query param to a number and
        // validates bounds at the HTTP boundary (S-M1 / P-W1).
        limit: t.Optional(t.Numeric({ minimum: 1, maximum: 50 })),
      }),
    },
  );
}
