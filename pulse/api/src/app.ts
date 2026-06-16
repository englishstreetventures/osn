import { cors } from "@elysiajs/cors";
import { DbLive, type Db } from "@pulse/db/service";
import { healthRoutes, observabilityPlugin } from "@shared/observability";
import type { Layer } from "effect";
import { Elysia } from "elysia";

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
}

/**
 * Compose the Pulse Elysia app. Factored out of the entry points so the same
 * graph runs on Bun.serve (`local.ts`, bun:sqlite) and on Cloudflare Workers
 * (`index.ts`, D1), with only the injected DB layer differing. Each route
 * factory already accepts the `dbLayer` (defaulting to `DbLive`), so the switch
 * is a single argument threaded through here.
 */
export function createApp(options: AppOptions = {}) {
  const { dbLayer = DbLive, jwksUrl } = options;

  return (
    // `aot: false` — Elysia's ahead-of-time compilation builds handlers via
    // `new Function`, which Cloudflare Workers forbid (no dynamic code eval).
    new Elysia({ aot: false })
      .use(cors())
      .use(observabilityPlugin({ serviceName: SERVICE_NAME }))
      .use(healthRoutes({ serviceName: SERVICE_NAME }))
      .get("/", () => ({ status: "ok", service: SERVICE_NAME }))
      .use(createEventsRoutes(dbLayer, jwksUrl))
      .use(createSeriesRoutes(dbLayer, jwksUrl))
      .use(createVenuesRoutes(dbLayer, jwksUrl))
      .use(createSettingsRoutes(dbLayer, jwksUrl))
      .use(createCloseFriendsRoutes(dbLayer, jwksUrl))
      .use(createOnboardingRoutes(dbLayer, jwksUrl))
      .use(createAccountRoutes(dbLayer, jwksUrl))
      .use(createInternalRoutes(dbLayer))
  );
}

export type App = ReturnType<typeof createApp>;
