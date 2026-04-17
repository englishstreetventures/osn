import { DbLive, type Db } from "@osn/db/service";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";
import { createRateLimiter, getClientIp, type RateLimiterBackend } from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccountId } from "../lib/auth-derive";
import { publicError } from "../lib/public-error";
import { metricAuthRateLimited } from "../metrics";
import { createAuthService, type AuthConfig } from "../services/auth";
import { createProfileService } from "../services/profile";

// ---------------------------------------------------------------------------
// Rate limiter types
// ---------------------------------------------------------------------------

export type ProfileRateLimiters = Readonly<{
  profileCreate: RateLimiterBackend;
  profileDelete: RateLimiterBackend;
  profileSetDefault: RateLimiterBackend;
}>;

export function createDefaultProfileRateLimiters(): ProfileRateLimiters {
  return {
    profileCreate: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    profileDelete: createRateLimiter({ maxRequests: 5, windowMs: 60_000 }),
    profileSetDefault: createRateLimiter({ maxRequests: 10, windowMs: 60_000 }),
  };
}

// ---------------------------------------------------------------------------
// Route factory
// ---------------------------------------------------------------------------

export function createProfileRoutes(
  authConfig: AuthConfig,
  dbLayer: Layer.Layer<Db> = DbLive,
  loggerLayer: Layer.Layer<never> = Layer.empty,
  rateLimiters: ProfileRateLimiters = createDefaultProfileRateLimiters(),
) {
  for (const [key, backend] of Object.entries(rateLimiters)) {
    if (typeof (backend as RateLimiterBackend)?.check !== "function") {
      throw new Error(`ProfileRateLimiters.${key} must have a check() method`);
    }
  }

  const auth = createAuthService(authConfig);
  const profile = createProfileService(auth);

  const run = <A, E>(eff: Effect.Effect<A, E, Db>): Promise<A> =>
    Effect.runPromise(
      eff.pipe(Effect.provide(dbLayer), Effect.provide(loggerLayer)) as Effect.Effect<
        A,
        never,
        never
      >,
    );

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  const rl = rateLimiters;

  async function rateLimit(
    headers: Record<string, string | undefined>,
    endpoint: AuthRateLimitedEndpoint,
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers);
    let allowed: boolean;
    try {
      allowed = await limiter.check(ip);
    } catch {
      allowed = false;
    }
    if (!allowed) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
    return null;
  }

  return new Elysia({ prefix: "" })
    .post(
      "/profiles/create",
      async ({ body, headers, set }) => {
        const rlErr = await rateLimit(headers, "profile_create", rl.profileCreate);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const principal = await resolveAccountId(auth, run, headers.authorization);
          if (!principal) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const result = await run(
            profile.createProfile(principal.accountId, body.handle, body.display_name),
          );
          set.status = 201;
          return { profile: result };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        body: t.Object({
          handle: t.String(),
          display_name: t.Optional(t.String()),
        }),
      },
    )
    .post(
      "/profiles/delete",
      async ({ body, headers, set }) => {
        const rlErr = await rateLimit(headers, "profile_delete", rl.profileDelete);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const principal = await resolveAccountId(auth, run, headers.authorization);
          if (!principal) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          await run(profile.deleteProfile(principal.accountId, body.profile_id));
          return { deleted: true };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        body: t.Object({
          profile_id: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
        }),
      },
    )
    .post(
      "/profiles/:profileId/default",
      async ({ params, headers, set }) => {
        const rlErr = await rateLimit(headers, "profile_set_default", rl.profileSetDefault);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const principal = await resolveAccountId(auth, run, headers.authorization);
          if (!principal) {
            set.status = 401;
            return { error: "unauthorized" };
          }
          const result = await run(
            profile.setDefaultProfile(principal.accountId, params.profileId),
          );
          return { profile: result };
        } catch (e) {
          const { status, body: errBody } = handleError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        params: t.Object({
          profileId: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
        }),
      },
    );
}
