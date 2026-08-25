import { DbLive, type Db } from "@osn/db/service";
import { createRateLimiter, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createRecommendationService } from "../services/recommendations";
import {
  errorResponse,
  organisationSearchResult,
  profileSearchResult,
  suggestionSummary,
} from "./response-schemas";

// ---------------------------------------------------------------------------
// Rate limiters — per-user fixed window
//
// Two budgets because the two endpoints have opposite shapes:
//
// - `/connections` runs a FOF fan-out that can return many rows, and is
//   requested once per page view. Tighter budget than graph/org writes to
//   limit DoS and graph-inference enumeration (S-H1).
// - `/search` is typeahead: cheap, index-backed in the common case, but fired
//   once per debounced keystroke. A 20/min budget would 429 a user mid-word,
//   so it gets the graph-write budget instead. It is still per-user and still
//   capped, which is what bounds handle enumeration.
// ---------------------------------------------------------------------------

const RECOMMENDATIONS_RATE_LIMIT_MAX = 20;
const RECOMMENDATIONS_RATE_LIMIT_WINDOW_MS = 60_000;
const SEARCH_RATE_LIMIT_MAX = 60;
const SEARCH_RATE_LIMIT_WINDOW_MS = 60_000;

export type RecommendationRateLimiters = Readonly<{
  /** Guards `GET /recommendations/connections` (the FOF fan-out). */
  suggest: RateLimiterBackend;
  /** Guards `GET /recommendations/search` (typeahead). */
  search: RateLimiterBackend;
}>;

/** Default in-memory recommendations rate limiters. Override for Redis. */
export function createDefaultRecommendationRateLimiters(): RecommendationRateLimiters {
  return {
    suggest: createRateLimiter({
      maxRequests: RECOMMENDATIONS_RATE_LIMIT_MAX,
      windowMs: RECOMMENDATIONS_RATE_LIMIT_WINDOW_MS,
    }),
    search: createRateLimiter({
      maxRequests: SEARCH_RATE_LIMIT_MAX,
      windowMs: SEARCH_RATE_LIMIT_WINDOW_MS,
    }),
  };
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
   * Per-user rate limiters for the suggestion fan-out and the search
   * typeahead. Supply Redis-backed backends in production via
   * `createRedisRecommendationRateLimiters`.
   */
  rateLimiters: RecommendationRateLimiters = createDefaultRecommendationRateLimiters(),
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  for (const key of ["suggest", "search"] as const) {
    if (typeof rateLimiters?.[key]?.check !== "function") {
      throw new Error(`RecommendationRateLimiters.${key} must have a check() method`);
    }
  }

  const auth = createAuthService(authConfig);
  const recommendations = createRecommendationService();

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

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
    limiter: RateLimiterBackend,
    profileId: string,
    set: { status?: number | string },
  ): Promise<boolean> {
    let allowed: boolean;
    try {
      allowed = await limiter.check(profileId);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      set.status = 429;
      return false;
    }
    return true;
  }

  return (
    new Elysia({ prefix: "/recommendations" })
      .get(
        "/connections",
        async ({ query, headers, set }) => {
          // Per-user connection suggestions — never cached or stored (tracker#468).
          set.headers["cache-control"] = "private, no-store";

          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(rateLimiters.suggest, caller.profileId, set))) {
            return { error: "Rate limit exceeded" };
          }
          try {
            // Schema guarantees limit is a finite integer in [1, 50] when present.
            const limit = query.limit ?? 10;
            const suggestions = await run(
              recommendations.suggestConnections(caller.profileId, limit),
            );
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
          response: {
            // An empty list is the normal answer for a new account with no
            // connections and no organisation — not a 404.
            200: t.Object({ suggestions: t.Array(suggestionSummary) }),
            401: errorResponse,
            429: errorResponse,
            // The fan-out is several queries deep; anything it throws is
            // swallowed and reported as one opaque "Request failed".
            500: errorResponse,
          },
          detail: { operationId: "suggestConnections", security: [{ bearerAuth: [] }] },
        },
      )
      // -----------------------------------------------------------------------
      // Search (autocomplete) — people and organisations in one round trip
      //
      // One endpoint rather than two because this backs a typeahead: a single
      // request per keystroke means one abort to cancel, one rate-limit budget
      // to reason about, and no torn state where the people half of a result
      // set is newer than the organisation half.
      //
      // `q` is deliberately permissive at the schema layer (any string up to 64
      // chars) — a search box takes whatever the user types, and the service
      // normalises + escapes it. Queries shorter than the service minimum come
      // back as empty lists, not a 4xx, so a half-typed word isn't an error.
      // -----------------------------------------------------------------------
      .get(
        "/search",
        async ({ query, headers, set }) => {
          // Per-user search results — never cached or stored (tracker#468).
          set.headers["cache-control"] = "private, no-store";

          const caller = await requireAuth(headers.authorization, set);
          if (!caller) return { error: "Unauthorized" };
          if (!(await requireRateLimit(rateLimiters.search, caller.profileId, set))) {
            return { error: "Rate limit exceeded" };
          }
          try {
            const limit = query.limit ?? 8;
            // `orgLimit` defaults smaller: organisations are the secondary
            // section in the UI, so they get a shorter list than people.
            const orgLimit = query.orgLimit ?? Math.max(1, Math.ceil(limit / 2));
            const [people, organisations] = await Promise.all([
              run(recommendations.searchProfiles(caller.profileId, query.q, limit)),
              run(recommendations.searchOrganisations(caller.profileId, query.q, orgLimit)),
            ]);
            return { people, organisations };
          } catch {
            set.status = 500;
            return { error: "Request failed" };
          }
        },
        {
          query: t.Object({
            q: t.String({ maxLength: 64 }),
            limit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
            orgLimit: t.Optional(t.Numeric({ minimum: 1, maximum: 20 })),
          }),
          response: {
            // Both halves always present, both possibly empty. A query below
            // the service's minimum length comes back as two empty lists at
            // 200 — a half-typed word is not a client error.
            200: t.Object({
              people: t.Array(profileSearchResult),
              organisations: t.Array(organisationSearchResult),
            }),
            401: errorResponse,
            429: errorResponse,
            500: errorResponse,
          },
          detail: { operationId: "searchProfilesAndOrganisations", security: [{ bearerAuth: [] }] },
        },
      )
  );
}
