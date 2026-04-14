import { DbLive, type Db } from "@osn/db/service";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { createRateLimiter, getClientIp, type RateLimiterBackend } from "../lib/rate-limit";
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

  function publicError(e: unknown): { status: number; body: { error: string; message?: string } } {
    const tag = (() => {
      const seen = new Set<unknown>();
      const queue: unknown[] = [e];
      while (queue.length) {
        const node = queue.shift();
        if (!node || typeof node !== "object" || seen.has(node)) continue;
        seen.add(node);
        const tagValue = (node as { _tag?: unknown })._tag;
        if (typeof tagValue === "string") return tagValue;
        for (const v of Object.values(node)) queue.push(v);
      }
      return null;
    })();

    void Effect.runPromise(
      Effect.logError("profile route error").pipe(
        Effect.annotateLogs({ tag: tag ?? "unknown" }),
        Effect.provide(loggerLayer),
      ),
    );

    switch (tag) {
      case "ValidationError":
        return { status: 400, body: { error: "invalid_request" } };
      case "AuthError":
        return { status: 400, body: { error: "invalid_request" } };
      case "DatabaseError":
        return { status: 500, body: { error: "internal_error" } };
      default:
        return { status: 400, body: { error: "invalid_request" } };
    }
  }

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
          const result = await run(
            profile.createProfile(body.refresh_token, body.handle, body.display_name),
          );
          set.status = 201;
          return { profile: result };
        } catch (e) {
          const { status, body: errBody } = publicError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        body: t.Object({
          refresh_token: t.String(),
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
          await run(profile.deleteProfile(body.refresh_token, body.profile_id));
          return { deleted: true };
        } catch (e) {
          const { status, body: errBody } = publicError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        body: t.Object({
          refresh_token: t.String(),
          profile_id: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
        }),
      },
    )
    .post(
      "/profiles/:profileId/default",
      async ({ body, params, headers, set }) => {
        const rlErr = await rateLimit(headers, "profile_set_default", rl.profileSetDefault);
        if (rlErr) {
          set.status = 429;
          return rlErr;
        }
        try {
          const result = await run(profile.setDefaultProfile(body.refresh_token, params.profileId));
          return { profile: result };
        } catch (e) {
          const { status, body: errBody } = publicError(e);
          set.status = status;
          return errBody;
        }
      },
      {
        params: t.Object({
          profileId: t.String({ pattern: "^usr_[a-f0-9]{12}$" }),
        }),
        body: t.Object({
          refresh_token: t.String(),
        }),
      },
    );
}
