import { cors } from "@elysiajs/cors";
import { DbLive, type Db } from "@pulse/db/service";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import type { ClientIpOptions } from "@shared/rate-limit";
import type { Layer } from "effect";
import { Elysia } from "elysia";

import { makeMemoryRateLimiters, type PulseRateLimiters } from "./redis";
import { createAccountRoutes } from "./routes/account";
import { createCloseFriendsRoutes } from "./routes/closeFriends";
import { createEventsRoutes, createSettingsRoutes } from "./routes/events";
import { createInternalRoutes } from "./routes/internal";
import { createOnboardingRoutes } from "./routes/onboarding";
import { createSeriesRoutes } from "./routes/series";
import { createVenuesRoutes } from "./routes/venues";

export const SERVICE_NAME = "pulse-api";

export interface AppOptions {
  /**
   * DB service layer. Defaults to the bun:sqlite `local` layer (dev + tests);
   * the Workers entry (`index.ts`) passes `makeDbD1Live(env.DB)` for the
   * `dev` / `staging` / `prod` environments.
   */
  dbLayer?: Layer.Layer<Db>;
  /** JWKS endpoint of the OSN issuer that signs access tokens. */
  jwksUrl?: string;
  /**
   * Rate limiter backends (W4). The composition root (`local.ts` long-lived
   * Bun host, or the per-isolate `index.ts` Worker) builds these from Redis
   * when `REDIS_URL` is configured and falls back to in-memory counters
   * otherwise. Omitted → in-memory limiters built here (tests / local).
   */
  rateLimiters?: PulseRateLimiters;
  /**
   * Client-IP trust policy (S-M34) for the per-IP limiters on the
   * unauthenticated discover / share / exposure surfaces. The composition
   * root derives this from `PULSE_TRUSTED_PROXY_COUNT` (or `trustCloudflare`
   * behind CF). Defaults to `{}` — direct mode, socket peer only.
   */
  clientIpConfig?: Omit<ClientIpOptions, "socketIp">;
  /**
   * CORS allowlist (P3). Replaces the bare `cors()` wildcard. The composition
   * root resolves + fail-closed-validates this via `lib/cors-config`. Omitted
   * → wildcard `cors()` (tests only).
   */
  corsOrigins?: string[];
}

/**
 * Compose the Pulse Elysia app. Factored out of the entry points so the same
 * graph runs on Bun.serve (`local.ts`, bun:sqlite) and on Cloudflare Workers
 * (`index.ts`, D1), with only the injected DB layer + rate-limiter backends
 * differing. Each route factory accepts the `dbLayer` and its rate limiters,
 * so the local/prod switch is purely a matter of the arguments threaded here.
 */
export function createApp(options: AppOptions = {}) {
  const {
    dbLayer = DbLive,
    jwksUrl,
    rateLimiters = makeMemoryRateLimiters(),
    clientIpConfig = {},
    corsOrigins,
  } = options;

  const { write, discovery, share, exposure } = rateLimiters;

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbid (no dynamic code eval).
    new Elysia({ aot: false })
      .use(corsOrigins ? cors({ origin: corsOrigins, credentials: true }) : cors())
      .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
      .use(healthRoutes({ serviceName: SERVICE_NAME }))
      .get("/", () => ({ status: "ok", service: SERVICE_NAME }))
      .use(
        createEventsRoutes(
          dbLayer,
          jwksUrl,
          undefined,
          discovery,
          share,
          exposure,
          {
            eventCreate: write.event_create,
            eventUpdate: write.event_update,
            rsvpUpsert: write.rsvp_upsert,
            eventInvite: write.event_invite,
            commsBlast: write.comms_blast,
          },
          clientIpConfig,
        ),
      )
      .use(
        createSeriesRoutes(dbLayer, jwksUrl, undefined, {
          seriesCreate: write.series_create,
          seriesUpdate: write.series_update,
        }),
      )
      .use(createVenuesRoutes(dbLayer, jwksUrl))
      .use(createSettingsRoutes(dbLayer, jwksUrl))
      .use(createCloseFriendsRoutes(dbLayer, jwksUrl, undefined, write.close_friend_mutate))
      .use(createOnboardingRoutes(dbLayer, jwksUrl))
      .use(createAccountRoutes(dbLayer, jwksUrl))
      .use(createInternalRoutes(dbLayer))
  );
}

export type App = ReturnType<typeof createApp>;
