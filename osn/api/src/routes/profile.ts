import { DbLive, type Db } from "@osn/db/service";
import type { AuthRateLimitedEndpoint } from "@shared/observability/metrics";
import {
  createRateLimiter,
  getClientIp,
  isUnresolvedIp,
  type ClientIpOptions,
  type RateLimiterBackend,
} from "@shared/rate-limit";
import { Effect, Layer } from "effect";
import { Elysia, t } from "elysia";

import { resolveAccountId } from "../lib/auth-derive";
import { publicError } from "../lib/public-error";
import { makeAppRunner, type AppRuntime } from "../lib/route-runtime";
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
  /**
   * Client-IP trust policy (S-M34). See `createAuthRoutes` for the full
   * contract. Defaults to `{}` (direct mode, socket peer only). Tests that
   * key per-IP buckets off an `x-forwarded-for` header pass
   * `{ trustedProxyCount: 1 }`.
   */
  clientIpConfig: Omit<ClientIpOptions, "socketIp"> = {},
  /** Shared application runtime (see `createAuthRoutes`). */
  runtime?: AppRuntime,
) {
  for (const [key, backend] of Object.entries(rateLimiters)) {
    if (typeof (backend as RateLimiterBackend)?.check !== "function") {
      throw new Error(`ProfileRateLimiters.${key} must have a check() method`);
    }
  }

  const auth = createAuthService(authConfig);
  const profile = createProfileService(auth);

  const { run } = makeAppRunner(runtime, Layer.merge(dbLayer, loggerLayer));

  const handleError = (e: unknown) => publicError(e, loggerLayer);

  const rl = rateLimiters;

  /** Per-request transport socket peer (S-M34); `null` under `app.handle`. */
  type IpCtx = {
    server: { requestIP?: (req: Request) => { address?: string } | null } | null;
    request: Request;
  };
  const socketIpOf = (ctx: IpCtx): string | null =>
    ctx.server?.requestIP?.(ctx.request)?.address ?? null;

  async function rateLimit(
    headers: Record<string, string | undefined>,
    socketIp: string | null,
    endpoint: AuthRateLimitedEndpoint,
    limiter: RateLimiterBackend,
  ): Promise<{ error: string } | null> {
    const ip = getClientIp(headers, { ...clientIpConfig, socketIp });
    // S-M34: never key the limiter on an unresolved IP — deny instead of
    // sharing one bucket across all un-attributable requests.
    if (isUnresolvedIp(ip)) {
      metricAuthRateLimited(endpoint);
      return { error: "rate_limited" };
    }
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
      async ({ body, headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "profile_create",
          rl.profileCreate,
        );
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
      async ({ body, headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "profile_delete",
          rl.profileDelete,
        );
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
      async ({ params, headers, set, server, request }) => {
        const rlErr = await rateLimit(
          headers,
          socketIpOf({ server, request }),
          "profile_set_default",
          rl.profileSetDefault,
        );
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
